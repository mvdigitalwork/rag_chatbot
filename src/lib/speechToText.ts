import OpenAI from "openai";
import fs from "fs";
import path from "path";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
});

export async function speechToText(audioBuffer: Buffer) {
    const tmpPath = path.join("/tmp", `audio-${Date.now()}.ogg`);
    fs.writeFileSync(tmpPath, audioBuffer);

    const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: "whisper-1",
        response_format: "verbose_json",
    });

    fs.unlinkSync(tmpPath);

    return {
        text: transcription.text,
        language: transcription.language || "unknown",
    };
}
