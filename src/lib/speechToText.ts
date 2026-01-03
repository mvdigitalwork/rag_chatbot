import Groq from "groq-sdk";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * Groq client
 */
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY!,
});

/**
 * Download audio from WhatsApp media URL and transcribe it
 */
export async function transcribeAudioFromUrl(mediaUrl: string): Promise<string | null> {
    try {
        // 1️⃣ Download audio
        const response = await fetch(mediaUrl);
        if (!response.ok) {
            console.error("Failed to download audio");
            return null;
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        // 2️⃣ Save temp audio file
        const tempDir = os.tmpdir();
        const audioPath = path.join(tempDir, `whatsapp-audio-${Date.now()}.ogg`);
        fs.writeFileSync(audioPath, buffer);

        // 3️⃣ Transcribe using Groq Whisper
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: "whisper-large-v3",
            response_format: "text",
        });

        // 4️⃣ Cleanup
        fs.unlinkSync(audioPath);

        return transcription?.trim() || null;
    } catch (err) {
        console.error("Speech-to-text error:", err);
        return null;
    }
}
