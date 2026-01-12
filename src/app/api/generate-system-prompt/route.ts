import { NextRequest, NextResponse } from "next/server";
import Groq from "groq-sdk";
import { supabase } from "@/lib/supabaseClient";

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { intent, phone_number } = body;

        if (!intent || !phone_number) {
            return NextResponse.json(
                { error: "Intent and phone_number are required" },
                { status: 400 }
            );
        }

        console.log("Generating system prompt for intent:", intent);

        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            temperature: 0.6,
            max_tokens: 500,
            messages: [
                {
                    role: "system",
                    content: `
You are an expert Conversational AI Architect.

Your task is to generate a SYSTEM PROMPT for a WhatsApp chatbot.

STRICT RULES (NON-NEGOTIABLE):

1. Language & Style Mirroring
- The chatbot MUST reply in the SAME language, script, and tone used by the user.
- If the user writes in Hinglish → reply in Hinglish.
- If the user writes in Hindi → reply in Hindi.
- If the user writes in English → reply in English.
- If the user mixes languages or writes broken sentences → reply naturally in the same style.
- NEVER mention language detection or switching.

2. Human-like Behavior
- Replies must feel natural, warm, and human.
- Professional but friendly tone.
- Light emojis allowed (😊 👍 😅), never overuse.
- WhatsApp-style short, clear messages.
- NEVER sound robotic, scripted, or automated.

3. Knowledge Usage
- The chatbot should answer strictly based on its available knowledge base.
- NEVER mention words like "document", "dataset", "source", "training data", or "knowledge base".

4. Fallback Rule (VERY IMPORTANT)
- If an exact answer is NOT available:
  - Politely say that the information is not available right now.
  - Offer help in another way.
  - Do NOT say why the data is missing.
  - Do NOT mention documents or internal data.

Example fallback styles:
- Hinglish: "Is topic pe abhi exact info available nahi hai 😊 Aap kuch aur poochna chahen to bataiye."
- Hindi: "Is vishay par abhi jaankari uplabdh nahi hai 😊 Aap koi aur sawaal pooch sakte hain."
- English: "I don’t have the right information on this yet 😊 Feel free to ask something else."

5. Personalization
- If the user's name is known, use it naturally in replies.
- Example: "Hi Rahul 😊", "Thanks for reaching out, Ayesha!"

Generate ONLY the system prompt text.
Do NOT add explanations or formatting.
Keep it under 250 words.
                    `.trim(),
                },
                {
                    role: "user",
                    content: `
Create a system prompt for a WhatsApp chatbot with the following intent:

"${intent}"
                    `.trim(),
                },
            ],
        });

        const systemPrompt = completion.choices[0]?.message?.content?.trim();

        if (!systemPrompt) {
            throw new Error("Failed to generate system prompt");
        }

        console.log("Generated system prompt:", systemPrompt);

        // Check existing mappings
        const { data: existingMappings } = await supabase
            .from("phone_document_mapping")
            .select("*")
            .eq("phone_number", phone_number);

        if (existingMappings && existingMappings.length > 0) {
            const { error } = await supabase
                .from("phone_document_mapping")
                .update({
                    intent,
                    system_prompt: systemPrompt,
                })
                .eq("phone_number", phone_number);

            if (error) throw error;
        } else {
            const { error } = await supabase
                .from("phone_document_mapping")
                .insert({
                    phone_number,
                    intent,
                    system_prompt: systemPrompt,
                    file_id: null,
                });

            if (error) throw error;
        }

        return NextResponse.json({
            success: true,
            system_prompt: systemPrompt,
            intent,
        });

    } catch (error) {
        console.error("System prompt generation error:", error);

        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Failed to generate system prompt",
            },
            { status: 500 }
        );
    }
}
