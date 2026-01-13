import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { generateAutoResponse } from "@/lib/autoResponder";
import { speechToText } from "@/lib/speechToText";

const NEGATIVE_KEYWORDS = [
  "no", "nahi", "nahin",
  "ok", "okay",
  "thanks", "thank you",
  "not interested",
  "later"
];

export async function POST(req: Request) {
  try {
    const payload = await req.json();

    console.log("📩 Received WhatsApp webhook:", payload);

    if (!payload.messageId || !payload.from || !payload.to) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    /* 1️⃣ Save incoming message */
    const { error } = await supabase.from("whatsapp_messages").insert([
      {
        message_id: payload.messageId,
        from_number: payload.from,
        to_number: payload.to,
        content_text: payload.content?.text || null,
        sender_name: payload.whatsapp?.senderName || null,
        raw_payload: payload,
      },
    ]);

    if (error && (error as any).code === "23505") {
      console.log("ℹ️ Duplicate message ignored");
      return NextResponse.json({ success: true });
    }

    if (payload.event !== "MoMessage") {
      return NextResponse.json({ success: true });
    }

    /* 2️⃣ Extract text / voice */
    let finalText: string | null = null;

    if (payload.content.contentType === "text") {
      finalText = payload.content.text?.trim() || null;
    }

    if (
      payload.content.contentType === "media" &&
      payload.content.media?.url &&
      ["voice", "audio"].includes(payload.content.media.type)
    ) {
      const stt = await speechToText(payload.content.media.url);
      finalText = stt?.text?.trim() || null;
    }

    if (!finalText) {
      return NextResponse.json({ success: true });
    }

    const lowerText = finalText.toLowerCase();

    /* 3️⃣ Load / create session */
    const { data: session } = await supabase
      .from("whatsapp_sessions")
      .select("*")
      .eq("from_number", payload.from)
      .eq("to_number", payload.to)
      .single();

    const currentState = session?.conversation_state || "ACTIVE";

    /* 🛑 HARD STOP CONDITIONS */
    if (["CTA_REJECTED", "CLOSED"].includes(currentState)) {
      console.log("🛑 Conversation already closed");
      return NextResponse.json({ success: true });
    }

    /* 4️⃣ Negative intent handling */
    const isNegative = NEGATIVE_KEYWORDS.some(k =>
      lowerText === k || lowerText.includes(k)
    );

    if (isNegative) {
      await supabase.from("whatsapp_sessions").upsert({
        from_number: payload.from,
        to_number: payload.to,
        conversation_state: "CTA_REJECTED",
        last_message: finalText,
        updated_at: new Date(),
      });

      await sendWhatsAppMessage(
        payload.from,
        payload.to,
        "Theek hai 😊 Agar future me help chahiye ho to bataiyega."
      );

      console.log("🚪 User rejected conversation");
      return NextResponse.json({ success: true });
    }

    /* 5️⃣ Update session as ACTIVE */
    await supabase.from("whatsapp_sessions").upsert({
      from_number: payload.from,
      to_number: payload.to,
      conversation_state: "ACTIVE",
      last_message: finalText,
      updated_at: new Date(),
    });

    /* 6️⃣ Generate AI response */
    await generateAutoResponse(
      payload.from,
      payload.to,
      finalText,
      payload.messageId
    );

    return NextResponse.json({ success: true });

  } catch (err) {
    console.error("WEBHOOK_ERROR:", err);
    return NextResponse.json({ error: "Webhook failed" }, { status: 500 });
  }
}

/* 🔹 Dummy sender (replace with 11za sender) */
async function sendWhatsAppMessage(from: string, to: string, text: string) {
  console.log("📤 Sending WhatsApp message:", text);
}
