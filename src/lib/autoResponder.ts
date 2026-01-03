import { supabase } from "./supabaseClient";
import { embedText } from "./embeddings";
import { retrieveRelevantChunksFromFiles } from "./retrieval";
import { getFilesForPhoneNumber } from "./phoneMapping";
import { sendWhatsAppMessage } from "./whatsappSender";
import Groq from "groq-sdk";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY!,
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
});

export type AutoResponseResult = {
    success: boolean;
    response?: string;
    error?: string;
    noDocuments?: boolean;
    sent?: boolean;
};

/**
 * Convert WhatsApp audio → text using Whisper
 */
async function speechToText(audioUrl: string): Promise<{ text: string; language: string }> {
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
        throw new Error("Failed to download WhatsApp audio");
    }

    const buffer = Buffer.from(await audioRes.arrayBuffer());
    const tmpPath = path.join("/tmp", `audio-${Date.now()}.ogg`);
    fs.writeFileSync(tmpPath, buffer);

    const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: "whisper-1",
        response_format: "verbose_json",
    });

    fs.unlinkSync(tmpPath);

    return {
        text: transcription.text || "",
        language: transcription.language || "english",
    };
}

/**
 * Detect language for text messages
 */
async function detectLanguage(text: string): Promise<string> {
    const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        messages: [
            {
                role: "system",
                content: "Detect the language of the given text. Reply with ONLY the language name."
            },
            { role: "user", content: text }
        ]
    });

    return completion.choices[0].message.content?.toLowerCase() || "english";
}

/**
 * MAIN AUTO RESPONDER
 */
export async function generateAutoResponse(
    fromNumber: string,
    toNumber: string,
    messageText: string | null,
    messageId: string,
    mediaUrl?: string
): Promise<AutoResponseResult> {
    try {
        // 1️⃣ Get documents mapped to business number
        const fileIds = await getFilesForPhoneNumber(toNumber);

        if (fileIds.length === 0) {
            return {
                success: false,
                noDocuments: true,
                error: "No documents mapped to this business number",
            };
        }

        // 2️⃣ Fetch phone config
        const { data: phoneMappings } = await supabase
            .from("phone_document_mapping")
            .select("system_prompt, intent, auth_token, origin")
            .eq("phone_number", toNumber);

        if (!phoneMappings || phoneMappings.length === 0) {
            return { success: false, error: "Phone mapping not found" };
        }

        const { system_prompt, auth_token, origin } = phoneMappings[0];

        if (!auth_token || !origin) {
            return {
                success: false,
                error: "WhatsApp API credentials missing",
            };
        }

        // 3️⃣ Normalize user input (TEXT or VOICE)
        let finalUserText = messageText || "";
        let detectedLanguage = "english";

        if (!finalUserText && mediaUrl) {
            const stt = await speechToText(mediaUrl);
            finalUserText = stt.text;
            detectedLanguage = stt.language;
        } else {
            detectedLanguage = await detectLanguage(finalUserText);
        }

        if (!finalUserText.trim()) {
            return { success: false, error: "Empty user message" };
        }

        // 4️⃣ RAG
        const queryEmbedding = await embedText(finalUserText);
        const matches = await retrieveRelevantChunksFromFiles(queryEmbedding, fileIds, 5);
        const contextText = matches.map(m => m.chunk).join("\n\n");

        // 5️⃣ Conversation history
        const { data: historyRows } = await supabase
            .from("whatsapp_messages")
            .select("content_text, event_type")
            .or(`from_number.eq.${fromNumber},to_number.eq.${fromNumber}`)
            .order("received_at", { ascending: true })
            .limit(20);

        const history = (historyRows || [])
            .filter(m => m.content_text)
            .map(m => ({
                role: m.event_type === "MoMessage" ? "user" as const : "assistant" as const,
                content: m.content_text
            }));

        // 6️⃣ System Prompt
        const rules = `
You MUST answer strictly from the provided CONTEXT.
If the answer is not present, say:
"I don't have that information in the document."

Reply in ${detectedLanguage}.
Keep it short, friendly and WhatsApp-ready.
`;

        const systemPrompt = `
${system_prompt || "You are a helpful WhatsApp assistant."}

${rules}

CONTEXT:
${contextText || "No relevant context found."}
`;

        // 7️⃣ LLM Call
        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            temperature: 0.2,
            max_tokens: 500,
            messages: [
                { role: "system", content: systemPrompt },
                ...history.slice(-10),
                { role: "user", content: finalUserText }
            ]
        });

        const response = completion.choices[0].message.content;

        if (!response) {
            return { success: false, error: "LLM returned empty response" };
        }

        // 8️⃣ Send WhatsApp reply
        const sendResult = await sendWhatsAppMessage(fromNumber, response, auth_token, origin);

        if (!sendResult.success) {
            return {
                success: false,
                response,
                sent: false,
                error: sendResult.error,
            };
        }

        // 9️⃣ Save AI message
        await supabase.from("whatsapp_messages").insert([
            {
                message_id: `auto_${messageId}_${Date.now()}`,
                channel: "whatsapp",
                from_number: toNumber,
                to_number: fromNumber,
                received_at: new Date().toISOString(),
                content_type: "text",
                content_text: response,
                sender_name: "AI Assistant",
                event_type: "MtMessage",
                is_in_24_window: true,
                raw_payload: { isAutoResponse: true }
            }
        ]);

        // 10️⃣ Mark responded
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
            sent: true,
        };

    } catch (error) {
        console.error("Auto-response error:", error);
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        };
    }
}
