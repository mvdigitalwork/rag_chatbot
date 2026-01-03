import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { generateAutoResponse } from "@/lib/autoResponder";
import { speechToText } from "@/lib/speechToText";

type WhatsAppWebhookPayload = {
    messageId: string;
    channel: string;
    from: string;
    to: string;
    receivedAt: string;
    content: {
        contentType: "text" | "media";
        text?: string;
        media?: {
            type: string;
            url: string;
        };
    };
    whatsapp?: {
        senderName?: string;
    };
    timestamp: string;
    event: string;
    isin24window?: boolean;
    isResponded?: boolean;
};

export async function POST(req: Request) {
    try {
        const payload: WhatsAppWebhookPayload = await req.json();

        console.log("📩 Received WhatsApp webhook:", payload);

        if (!payload.messageId || !payload.from || !payload.to) {
            return NextResponse.json(
                { error: "Missing required fields" },
                { status: 400 }
            );
        }

        // 1️⃣ Store incoming message (text OR voice)
        const { error } = await supabase.from("whatsapp_messages").insert([
            {
                message_id: payload.messageId,
                channel: payload.channel,
                from_number: payload.from,
                to_number: payload.to,
                received_at: payload.receivedAt,
                content_type: payload.content?.contentType,
                content_text: payload.content?.text || null,
                sender_name: payload.whatsapp?.senderName,
                event_type: payload.event,
                is_in_24_window: payload.isin24window || false,
                is_responded: payload.isResponded || false,
                raw_payload: payload,
            },
        ]);

        if (error) {
            if (error.code === "23505") {
                return NextResponse.json({ success: true, duplicate: true });
            }
            throw error;
        }

        // Only respond to user messages
        if (payload.event !== "MoMessage") {
            return NextResponse.json({ success: true });
        }

        let finalText: string | null = null;
        let mediaUrl: string | undefined;

        // 2️⃣ TEXT MESSAGE
        if (payload.content.contentType === "text") {
            finalText = payload.content.text || null;
        }

        // 3️⃣ VOICE MESSAGE
        if (
            payload.content.contentType === "media" &&
            payload.content.media?.type === "audio"
        ) {
            mediaUrl = payload.content.media.url;
            console.log("🎙 Voice message detected:", mediaUrl);

            const stt = await speechToText(mediaUrl);

            if (!stt || !stt.text) {
                console.error("❌ Speech-to-text failed");
                return NextResponse.json({ success: false });
            }

            finalText = stt.text;
            console.log("📝 Transcribed text:", finalText);
        }

        if (!finalText) {
            console.warn("⚠️ No usable message content");
            return NextResponse.json({ success: true });
        }

        // 4️⃣ Generate AI response
        await generateAutoResponse(
            payload.from,
            payload.to,
            finalText,
            payload.messageId,
            mediaUrl
        );

        return NextResponse.json({ success: true });

    } catch (err) {
        console.error("WEBHOOK_ERROR:", err);
        return NextResponse.json(
            { error: "Webhook processing failed" },
            { status: 500 }
        );
    }
}
