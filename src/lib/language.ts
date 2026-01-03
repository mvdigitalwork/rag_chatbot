import Groq from "groq-sdk";

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY!,
});

export async function detectLanguage(text: string): Promise<string> {
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

    return completion.choices[0].message.content.toLowerCase();
}
