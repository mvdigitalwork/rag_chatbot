import { supabase } from "./supabaseClient";
import { embedText } from "./embeddings";
import { retrieveRelevantChunksFromFiles } from "./retrieval";
import { getFilesForPhoneNumber } from "./phoneMapping";
import { sendWhatsAppMessage } from "./whatsappSender";
import { speechToText } from "./speechToText";
import Groq from "groq-sdk";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

/* 🔒 FIXED RETURN TYPE */
export type AutoResponseResult = {
  success: boolean;
  response: string | null;
  error: string | null;
  noDocuments: boolean;
  sent: boolean;
};

/* 🔤 Limited Language Detection */
function normalizeLanguage(lang: string) {
  const l = lang.toLowerCase();
  if (l.includes("gujarati")) return "Gujarati";
  if (l.includes("hindi")) return "Hindi";
  if (l.includes("hinglish")) return "Hinglish";
  return "English";
}

async function detectLanguage(text: string): Promise<string> {
  try {
    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Detect the language. Reply ONLY with: Hindi, Hinglish, English, Gujarati.",
        },
        { role: "user", content: text },
      ],
    });

    return normalizeLanguage(res.choices[0].message.content || "English");
  } catch {
    return "English";
  }
}

/* ================= MAIN ================= */

export async function generateAutoResponse(
  fromNumber: string,
  toNumber: string,
  messageText: string | null,
  messageId: string,
  mediaUrl?: string
): Promise<AutoResponseResult> {
  try {
    /* 🚫 STOP if already responded */
    const { data: existing } = await supabase
      .from("whatsapp_messages")
      .select("auto_respond_sent")
      .eq("message_id", messageId)
      .single();

    if (existing?.auto_respond_sent) {
      return {
        success: true,
        response: null,
        error: null,
        noDocuments: false,
        sent: false,
      };
    }

    /* 1️⃣ Files */
    const fileIds = await getFilesForPhoneNumber(toNumber);
    if (fileIds.length === 0) {
      return {
        success: false,
        response: null,
        error: "No information available",
        noDocuments: true,
        sent: false,
      };
    }

    /* 2️⃣ Phone config */
    const { data: mapping } = await supabase
      .from("phone_document_mapping")
      .select("system_prompt, auth_token, origin")
      .eq("phone_number", toNumber)
      .limit(1)
      .single();

    if (!mapping?.auth_token || !mapping?.origin) {
      return {
        success: false,
        response: null,
        error: "WhatsApp credentials missing",
        noDocuments: false,
        sent: false,
      };
    }

    /* 3️⃣ User text */
    let userText = messageText?.trim() || "";
    let language = "English";

    if (!userText && mediaUrl) {
      const stt = await speechToText(mediaUrl);
      if (!stt?.text) {
        return {
          success: false,
          response: null,
          error: "Voice transcription failed",
          noDocuments: false,
          sent: false,
        };
      }
      userText = stt.text;
    }

    language = await detectLanguage(userText);

    /* 4️⃣ RAG */
    const embedding = await embedText(userText);
    if (!embedding) {
      return {
        success: false,
        response: null,
        error: "Embedding failed",
        noDocuments: false,
        sent: false,
      };
    }

    const matches = await retrieveRelevantChunksFromFiles(
      embedding,
      fileIds,
      5
    );

    const contextText = matches.map(m => m.chunk).join("\n\n");

    /* 5️⃣ Prompt */
    const systemPrompt = `
You are a WhatsApp assistant.

RULES:
- Reply ONLY in ${language}
- Be friendly, human, WhatsApp-style
- Light emojis allowed 😊
- NEVER mention document, data, source

IF info missing:
Politely say info is not available and stop.

INFORMATION:
${contextText || "No relevant information available"}
`.trim();

    /* 6️⃣ LLM */
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    });

    const response = completion.choices[0].message.content?.trim();
    if (!response) {
      return {
        success: false,
        response: null,
        error: "Empty AI response",
        noDocuments: false,
        sent: false,
      };
    }

    /* 7️⃣ Send WhatsApp */
    await sendWhatsAppMessage(
      fromNumber,
      response,
      mapping.auth_token,
      mapping.origin
    );

    /* 8️⃣ Save AI message */
    await supabase.from("whatsapp_messages").insert({
      message_id: `auto_${messageId}`,
      from_number: toNumber,
      to_number: fromNumber,
      content_text: response,
      event_type: "MtMessage",
      auto_respond_sent: true,
      response_sent_at: new Date().toISOString(),
    });

    /* 9️⃣ Mark original */
    await supabase
      .from("whatsapp_messages")
      .update({
        auto_respond_sent: true,
        response_sent_at: new Date().toISOString(),
      })
      .eq("message_id", messageId);

    return {
      success: true,
      response,
      error: null,
      noDocuments: false,
      sent: true,
    };
  } catch (err) {
    console.error("Auto-response error:", err);
    return {
      success: false,
      response: null,
      error: "Auto response failed",
      noDocuments: false,
      sent: false,
    };
  }
}
