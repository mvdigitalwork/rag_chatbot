import Groq from "groq-sdk";
import fs from "fs";
import path from "path";

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY!,
});

/**
 * FREE Voice → Text using Groq Whisper
 */
export async function speechToText(
    audioUrl: string
): Promise<{ text: string; language: string } | null> {
    try {
        console.log("⬇️ Downloading audio:", audioUrl);

        const res = await fetch(audioUrl);
        if (!res.ok) throw new Error("Audio download failed");

        const buffer = Buffer.from(await res.arrayBuffer());
        const audioPath = path.join("/tmp", `voice-${Date.now()}.ogg`);
        fs.writeFileSync(audioPath, buffer);

        console.log("🎧 Audio saved:", audioPath);

        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: "whisper-large-v3",
            response_format: "verbose_json",
        });

        fs.unlinkSync(audioPath);

        const text = transcription.text?.trim();
        if (!text) return null;

        return {
            text,
            language: transcription.language || "unknown",
        };

    } catch (err) {
        console.error("❌ Groq STT failed:", err);
        return null;
    }
}
