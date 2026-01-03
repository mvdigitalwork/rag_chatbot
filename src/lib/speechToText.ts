import fs from "fs";
import path from "path";

export async function speechToText(
    audioUrl: string
): Promise<{ text: string; language: string } | null> {
    try {
        const res = await fetch(audioUrl);
        if (!res.ok) {
            throw new Error("Failed to download audio file");
        }

        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const audioPath = path.join("/tmp", `voice-${Date.now()}.ogg`);
        fs.writeFileSync(audioPath, buffer);

        const fileBuffer = fs.readFileSync(audioPath);

        const formData = new FormData();
        const blob = new Blob([fileBuffer], { type: "audio/ogg" });
        formData.append("file", blob, "voice.ogg");
        formData.append("model", "whisper-1");
        formData.append("response_format", "verbose_json");

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            fs.unlinkSync(audioPath);
            return null;
        }

        const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            
            body: formData as any,
        });

        fs.unlinkSync(audioPath);

        if (!resp.ok) {
            return null;
        }

        const json = await resp.json();

        const text = (json?.text as string) || null;
        const language = (json?.language as string) || (json?.detected_language as string) || "english";

        if (!text) return null;

        return { text: text.trim(), language };
    } catch (err) {
        console.error("Speech-to-text error:", err);
        return null;
    }
}
