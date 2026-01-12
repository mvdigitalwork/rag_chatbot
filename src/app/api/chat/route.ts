import { NextResponse } from "next/server";
import Groq from "groq-sdk";
import { supabase } from "@/lib/supabaseClient";
import { embedText } from "@/lib/embeddings";
import { retrieveRelevantChunks } from "@/lib/retrieval";

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY!,
});

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { session_id, message, file_id } = body;

        if (!session_id || !message) {
            return NextResponse.json(
                { error: "session_id and message are required" },
                { status: 400 }
            );
        }

        // 1️⃣ Embed user query
        const queryEmbedding = await embedText(message);
        if (!queryEmbedding) {
            return NextResponse.json(
                { error: "Embedding failed" },
                { status: 500 }
            );
        }

        // 2️⃣ Retrieve relevant chunks
        const matches = await retrieveRelevantChunks(queryEmbedding, file_id, 5);
        const contextText = matches.map(m => m.chunk).join("\n\n");

        // 3️⃣ Load chat history
        const { data: historyRows } = await supabase
            .from("messages")
            .select("role, content")
            .eq("session_id", session_id)
            .order("created_at", { ascending: true });

        const history = (historyRows || []).map(m => ({
            role: m.role,
            content: m.content
        }));

        // 4️⃣ SYSTEM PROMPT (CRITICAL FIX)
        const systemPrompt = `
You are a WhatsApp conversational assistant.

STRICT BEHAVIOR RULES:

1. Language Mirroring (Mandatory)
- Reply in the SAME language and style as the user.
- Hindi → Hindi
- English → English
- Hinglish → Hinglish
- Broken / casual → reply naturally the same way
- Do NOT mention language detection.

2. Knowledge Boundary
- Answer ONLY using the information provided below.
- If the answer is not clearly available:
  - Politely say the information is not available right now.
  - Do NOT guess or assume.
  - Do NOT explain why.

3. Forbidden Words
- NEVER use words like:
  "document", "documents", "dataset", "knowledge base", "data source", "training data"

4. Human Tone
- Professional but friendly
- WhatsApp-style short replies
- Light emojis allowed 😊
- Never robotic

Fallback examples:
- Hinglish: "Is topic pe abhi exact info available nahi hai 😊 Aap kuch aur pooch sakte ho."
- Hindi: "Is vishay par abhi jaankari uplabdh nahi hai 😊"
- English: "I don’t have the right information on this yet 😊"

INFORMATION:
${contextText || "No relevant information available."}
        `.trim();

        const messages = [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: message }
        ];

        // 5️⃣ Stream response from Groq
        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages,
            temperature: 0.3,
            stream: true,
        });

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    for await (const chunk of completion) {
                        const content = chunk.choices[0]?.delta?.content;
                        if (content) {
                            controller.enqueue(encoder.encode(content));
                        }
                    }
                    controller.close();
                } catch (err) {
                    controller.error(err);
                }
            }
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Transfer-Encoding": "chunked",
            },
        });

    } catch (err) {
        console.error("CHAT_ERROR:", err);
        return NextResponse.json(
            { error: "Chat processing failed" },
            { status: 500 }
        );
    }
}
