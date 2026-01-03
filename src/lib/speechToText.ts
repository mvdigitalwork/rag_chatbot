import fs from "fs";
import path from "path";

/**
 * Convert WhatsApp voice/audio → text using OpenAI Whisper (REST)
 * SDK-free, Vercel-safe
 */
export async function speechToText(
    audioUrl: string
): Promise<{ text: string; language: string } | null> {
    try {
        console.log("⬇️ Downloading audio:", audioUrl);

        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) {
            throw new Error("Failed to download audio file");
        }

        const buffer = Buffer.from(await audioRes.arrayBuffer());
        const filePath = path.join("/tmp", `voice-${Date.now()}.ogg`);
        fs.writeFileSync(filePath, buffer);

        console.log("🎧 Audio saved:", filePath);

        const formData = new FormData();
        formData.append(
            "file",
            new Blob([fs.readFileSync(filePath)]),
            "voice.ogg"
        );
        formData.append("model", "whisper-1");
        formData.append("response_format", "verbose_json");

        const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: formData as any,
        });

        fs.unlinkSync(filePath);

        if (!res.ok) {
            const errText = await res.text();
            console.error("❌ Whisper API error:", errText);
            return null;
        }

        const json = await res.json();

        const text = json.text?.trim();
        const language = json.language || "english";

        if (!text) {
            console.error("❌ Empty transcription result");
            return null;
        }

        console.log("📝 Transcription success:", text);

        return { text, language };

    } catch (err) {
        console.error("❌ Speech-to-text error:", err);
        return null;
    }
}
