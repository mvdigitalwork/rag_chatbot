import OpenAI from "openai";
import fs from "fs";
import path from "path";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
});

/**
 * Converts WhatsApp audio (URL) → text using Whisper
 * Supports multi-language input automatically
 */
export async function speechToText(
    audioUrl: string
): Promise<{ text: string; language: string } | null> {
    try {
        const res = await fetch(audioUrl);
        if (!res.ok) {
            throw new Error("Failed to download audio file");
        }

        const buffer = Buffer.from(await res.arrayBuffer());

        const audioPath = path.join("/tmp", `voice-${Date.now()}.ogg`);
        fs.writeFileSync(audioPath, buffer);

        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: "whisper-1",
            response_format: "verbose_json",
        });

        fs.unlinkSync(audioPath);

        const text = transcription.text?.trim();

        if (!text) {
            return null;
        }

        return {
            text,
            language: transcription.language || "english",
        };
    } catch (err) {
        console.error("Speech-to-text error:", err);
        return null;
    }
}
