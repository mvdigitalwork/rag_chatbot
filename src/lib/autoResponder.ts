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

/* ❌ STOP WORDS */
const NEGATIVE_KEYWORDS = [
  "no", "nahi", "nahin",
  "ok", "okay",
  "thanks", "thank you",
  "not interested", "later"
];

/* 🧠 Language detection (ONLY 4) */
function detectLanguage(text: string): "hinglish" | "hindi" | "english" | "gujarati" {
  if (/[\u0A80-\u0AFF]/.test(text)) return "gujarati";
  if (/[\u0900-\u097F]/.test(text)) return "hindi";
  if (/(hai|nahi|kya|ka|ki|ho)/i.test(text)) return "hinglish";
  return "english";
}

/* 🔁 Fallback replies */
function fallback(lang: string) {
  switch (lang) {
    case "hinglish":
      return "Is topic pe abhi exact info available nahi hai 😊";
    case "hindi":
      return "Is vishay par abhi jaankari uplabdh nahi hai 😊";
    case "gujarati":
      return "આ વિષય પર હાલમાં માહિતી ઉપલબ્ધ નથી 😊";
    default:
      return "I don’t have the right information on this yet 😊";
  }
}

export async function generateAutoResponse(
  fromNumber: string,
  toNumber: string,
  messageText: string | null,
  messageId: string,
  mediaUrl?: string
) {
  try {
    /* 1️⃣ Session check */
    const { data: session } = await supabase
      .from("whatsapp_sessions")
      .select("*")
      .eq("from_number", fromNumber)
      .eq("to_number", toNumber)
      .single();

    if (session?.conversation_state === "STOPPED") {
      return { success: true };
    }

    /* 2️⃣ Normalize input */
    let finalText = messageText?.trim() || "";

    if (!finalText && mediaUrl) {
      const stt = await speechToText(mediaUrl);
      if (!stt?.text) return { success: false };
      finalText = stt.text.trim();
    }

    if (!finalText) return { success: false };

    const lower = finalText.toLowerCase();

    /* 🛑 NEGATIVE INTENT */
    if (NEGATIVE_KEYWORDS.some(k => lower === k || lower.includes(k))) {
      await supabase.from("whatsapp_sessions").upsert({
        from_number: fromNumber,
        to_number: toNumber,
        conversation_state: "STOPPED",
        last_user_message: finalText,
      });

      await sendWhatsAppMessage(
        fromNumber,
        "Theek hai 😊",
        process.env.WHATSAPP_11ZA_AUTH_TOKEN!,
        process.env.WHATSAPP_11ZA_ORIGIN!
      );

      return { success: true };
    }

    /* 3️⃣ Language */
    const language = detectLanguage(finalText);

    /* 4️⃣ Files */
    const fileIds = await getFilesForPhoneNumber(toNumber);
    if (fileIds.length === 0) {
      const reply = fallback(language);
      await sendWhatsAppMessage(fromNumber, reply,
        process.env.WHATSAPP_11ZA_AUTH_TOKEN!,
        process.env.WHATSAPP_11ZA_ORIGIN!
      );
      return { success: true };
    }

    /* 5️⃣ RAG */
    const embedding = await embedText(finalText);
    const matches = await retrieveRelevantChunksFromFiles(embedding, fileIds, 5);
    const contextText = matches.map(m => m.chunk).join("\n\n");

    /* 6️⃣ SYSTEM PROMPT */
    const systemPrompt = `
You are a WhatsApp assistant.

RULES:
- Reply ONLY in ${language}.
- Be short, friendly, human.
- Light emojis 😊.
- Use ONLY the information below.
- If info not found, say it politely.
- NEVER guess.
- NEVER mention documents or data.

INFO:
${contextText || "NO_INFO"}
`.trim();

    /* 7️⃣ LLM */
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: finalText }
      ],
    });

    const reply =
      completion.choices[0]?.message?.content?.trim() ||
      fallback(language);

    /* 8️⃣ Send reply */
    await sendWhatsAppMessage(
      fromNumber,
      reply,
      process.env.WHATSAPP_11ZA_AUTH_TOKEN!,
      process.env.WHATSAPP_11ZA_ORIGIN!
    );

    /* 9️⃣ Save session */
    await supabase.from("whatsapp_sessions").upsert({
      from_number: fromNumber,
      to_number: toNumber,
      conversation_state: "ACTIVE",
      last_user_message: finalText,
    });

    return { success: true, response: reply };

  } catch (err) {
    console.error("AutoResponder Error:", err);
    return { success: false };
  }
}
