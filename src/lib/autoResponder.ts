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

export type AutoResponseResult = {
  success: boolean;
  response?: string;
  error?: string;
  noDocuments?: boolean;
  sent?: boolean;
};

/* ---------------- HELPERS ---------------- */

function cleanUserName(name?: string | null) {
  if (!name) return null;
  return name.replace(/[^\p{L}\p{N}\s]/gu, "").trim();
}

function greetingPrefix(language: string, name?: string | null) {
  if (!name) return "";
  return `Hi ${name} 😊 `;
}

/* ---------------------------------------- */

export async function generateAutoResponse(
  fromNumber: string,
  toNumber: string,
  messageText: string | null,
  messageId: string,
  mediaUrl?: string,
  senderName?: string
): Promise<AutoResponseResult> {
  try {
    /* 1️⃣ FILES */
    const fileIds = await getFilesForPhoneNumber(toNumber);
    if (fileIds.length === 0) {
      return { success: false, noDocuments: true };
    }

    /* 2️⃣ PHONE CONFIG */
    const { data: phoneMappings } = await supabase
      .from("phone_document_mapping")
      .select("system_prompt, auth_token, origin")
      .eq("phone_number", toNumber)
      .limit(1);

    if (!phoneMappings?.length) {
      return { success: false, error: "Phone config missing" };
    }

    const { system_prompt, auth_token, origin } = phoneMappings[0];
    if (!auth_token || !origin) {
      return { success: false, error: "WhatsApp credentials missing" };
    }

    /* 3️⃣ USER TEXT (TEXT / VOICE) */
    let finalUserText = messageText?.trim() || "";
    if (!finalUserText && mediaUrl) {
      const transcript = await speechToText(mediaUrl);
      if (!transcript?.text) {
        return { success: false, error: "Voice transcription failed" };
      }
      finalUserText = transcript.text;
    }

    if (!finalUserText) {
      return { success: false, error: "Empty message" };
    }

    /* 4️⃣ EMBEDDING + RAG */
    const queryEmbedding = await embedText(finalUserText);
    if (!queryEmbedding) {
      return { success: false, error: "Embedding failed" };
    }

    const matches = await retrieveRelevantChunksFromFiles(
      queryEmbedding,
      fileIds,
      6
    );

    const contextText = matches.map(m => m.chunk).join("\n\n");

    /* 5️⃣ HISTORY */
    const { data: historyRows } = await supabase
      .from("whatsapp_messages")
      .select("content_text, event_type")
      .or(`from_number.eq.${fromNumber},to_number.eq.${fromNumber}`)
      .order("received_at", { ascending: true })
      .limit(15);

    const history = (historyRows || [])
      .filter(m => m.content_text)
      .map(m => ({
        role: m.event_type === "MoMessage" ? "user" : "assistant",
        content: m.content_text,
      }));

    /* 6️⃣ DAY CONTEXT */
    const currentDay = new Date().toLocaleDateString("en-US", {
      weekday: "long",
    });

    const userName = cleanUserName(senderName);

    /* 7️⃣ 🔥 SMART SYSTEM PROMPT */
    const systemPrompt = `
${system_prompt || "You are a smart WhatsApp assistant."}

LANGUAGE RULES (STRICT):
- You can reply ONLY in:
  Hinglish, English, Hindi (देवनागरी), Gujarati (ગુજરાતી)
- Match user's writing style naturally
- Never mention language detection

TODAY:
- Today is ${currentDay}

INTELLIGENCE:
- If user asks about offers / discounts / deals:
  → Respond ONLY with ${currentDay}'s information
  → Ignore all other days completely

KNOWLEDGE:
- Use ONLY the INFORMATION section
- If today's info is missing:
  → Politely say it's not available
  → Do NOT explain why

STYLE:
- Friendly, short WhatsApp replies
- Light emojis 😊
- Never robotic

FORBIDDEN WORDS:
document, dataset, source, training data, knowledge base

INFORMATION:
${contextText || "NO_INFORMATION_AVAILABLE"}
`.trim();

    /* 8️⃣ LLM */
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.slice(-10),
        { role: "user", content: finalUserText },
      ],
    });

    let reply = completion.choices[0]?.message?.content;
    if (!reply) {
      return { success: false, error: "Empty AI response" };
    }

    /* 9️⃣ NAME GREETING (ONLY FIRST BOT REPLY) */
    if (history.length === 0 && userName) {
      reply = greetingPrefix("hinglish", userName) + reply;
    }

    /* 🔟 SEND WHATSAPP */
    const sendResult = await sendWhatsAppMessage(
      fromNumber,
      reply,
      auth_token,
      origin
    );

    if (!sendResult.success) {
      return { success: false, error: sendResult.error };
    }

    /* 11️⃣ SAVE BOT MESSAGE */
    await supabase.from("whatsapp_messages").insert({
      message_id: `auto_${messageId}_${Date.now()}`,
      channel: "whatsapp",
      from_number: toNumber,
      to_number: fromNumber,
      received_at: new Date().toISOString(),
      content_type: "text",
      content_text: reply,
      sender_name: "AI Assistant",
      event_type: "MtMessage",
      is_in_24_window: true,
    });

    return { success: true, response: reply, sent: true };
  } catch (error) {
    console.error("Auto-response error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
