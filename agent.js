import { streamText, tool, generateText } from "ai"
import { z } from 'zod';
import dotenv from 'dotenv'
import { Valyu } from 'valyu-js';
import { anthropic } from "@ai-sdk/anthropic"
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import sharp from 'sharp';

// Load environment variables
dotenv.config()

// Initialize Valyu client
const valyu = new Valyu(process.env.VALYU_API_KEY);

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Directory to save downloaded images
const IMAGE_DIR = path.join(process.cwd(), 'downloaded_images');
if (!fs.existsSync(IMAGE_DIR)) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

// JSON store for conversation history
const MESSAGE_STORE = path.join(process.cwd(), 'conversation_history.json');
// Reset the store at startup
try {
  fs.writeFileSync(MESSAGE_STORE, JSON.stringify([], null, 2));
} catch (e) {
  console.error('⚠️  Unable to reset conversation history file:', e);
}

function persistHistory(history) {
  try {
    const safeHistory = history ?? [];
    fs.writeFileSync(MESSAGE_STORE, JSON.stringify(safeHistory, null, 2));
  } catch (e) {
    console.error('⚠️  Failed to persist conversation history:', e);
  }
}

// Global counter so each image ID is unique across the whole session
let globalImageID = 1;

const valyuSearchTool = tool({
    description: 'Search Valyu\'s multimodal knowledge graph for information across any domain. Use this tool whenever external factual information is needed.',
    parameters: z.object({
      query: z.string().describe('Specific, detailed search query focusing on the exact information needed'),
      maxResults: z.number().min(1).max(20).default(5).describe('Maximum number of results to return'),
    }),
    execute: async ({ query, maxResults }) => {
      try {
        const response = await valyu.search(query, {
          searchType: 'all',
          maxNumResults: maxResults,
          maxPrice: 1000,
          isToolCall: true,
        });

        if (!response.success) {
          return {
            result: {
              success: false,
              error: response.error || 'Search failed',
              results: []
            }
          };
        }

        const formattedResults = response.results?.map((result, index) => ({
          title: result.title || 'Untitled Source',
          content: result.content,
          url: result.url,
          source: result.source,
          relevanceScore: result.relevance_score,
          images: (() => {
            // According to Valyu docs, images come as an image_urls dict { name: url }
            const dict = result.image_url || {};
            const urls = Object.values(dict);
            if (urls.length > 0) {
              console.log(`🔗 Extracted ${urls.length} image URLs from result "${result.title}"`);
            }
            return urls.slice(0, 2); // take first 2 if available
          })(),
          citation: `[${result.title || 'Untitled Source'}]${result.url ? `(${result.url})` : ''}`
        })) || [];

        // Gather at most 1 non-SVG image overall (prevent huge prompts)
        const rawImages = formattedResults.flatMap(r => r.images);
        const imageUrls = rawImages.filter(u => {
          try {
            const ext = path.extname(new URL(u).pathname).toLowerCase();
            return ext !== '.svg' && ext !== '.svgz';
          } catch {
            return false;
          }
        }).slice(0, 1);

        // Prepare text snippets (top 5 results)
        const textSnippets = formattedResults.slice(0, 5).map((r, idx) => {
          const snippet = r.content ? r.content.slice(0, 600) : '';
          return `SOURCE ${idx + 1}: ${r.title}\n${snippet}\n${r.citation}`;
        });

        if (imageUrls.length === 0) {
          return { success: true, texts: textSnippets };
        }

        // Download first image and return buffer & mimeType
        try {
          const imgUrl = imageUrls[0];
          const resp = await fetch(imgUrl);
          if (!resp.ok) {
            return { success: true, texts: textSnippets };
          }
          const originalBuffer = Buffer.from(await resp.arrayBuffer());

          // Resize & compress to keep prompt small (max 768 px, 70% quality JPEG)
          let buffer = originalBuffer;
          let mimeType = resp.headers.get('content-type') || 'image/jpeg';
          try {
            buffer = await sharp(originalBuffer)
              .resize({ width: 768, height: 768, fit: 'inside' })
              .jpeg({ quality: 70 })
              .toBuffer();
            mimeType = 'image/jpeg';
          } catch (err) {
            console.error('⚠️  Image compression failed, using original buffer:', err);
            buffer = originalBuffer;
          }

          // Save locally for inspection
          const currentId = globalImageID++;
          const cleanLabel = `IMG${currentId}`;
          const extMatch = mimeType.match(/image\/(.+)/);
          const ext = extMatch ? `.${extMatch[1]}` : '.jpg';
          const filePath = path.join(IMAGE_DIR, `${cleanLabel}${ext}`);
          try {
            await fs.promises.writeFile(filePath, buffer);
            console.log(`🖼️  Saved image fed to model: ${filePath}`);
          } catch (e) {
            console.error('⚠️  Failed to save image locally:', e);
          }

          // Return binary data so SDK emits proper ImagePart
          return {
            success: true,
            texts: textSnippets,
            images: [{ label: cleanLabel, data: buffer.toString('base64'), mimeType }]
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          return { success: false, error: msg };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
          result: {
            success: false,
            error: errorMessage,
            results: []
          }
        };
      }
    },

    // Convert tool output into text+image-url parts for the model
    experimental_toToolResultContent: (out) => {
      const parts = [];

      // Add textual snippets first
      if (out?.texts && Array.isArray(out.texts)) {
        out.texts.forEach(t => parts.push({ type: 'text', text: t }));
      }

      // Then add the first image (if any)
      if (out?.images && out.images.length) {
        const item = out.images[0];
        parts.push({ type: 'text', text: `[${item.label}]` });
        parts.push({ type: 'image', data: item.data, mimeType: item.mimeType });
      }

      if (parts.length === 0) {
        return [{ type: 'text', text: 'No relevant results.' }];
      }
      return parts;
    }
});

// Store conversation history
let conversationHistory = [];

async function downloadAndSaveImage(url, label) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`⚠️  Failed to download image ${url}: ${response.statusText}`);
      return;
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const ext = path.extname(new URL(url).pathname) || '.jpg';
    const cleanLabel = label.replace(/[\[\]]/g, ''); // remove brackets for filename
    const fileName = `${cleanLabel}${ext}`;
    const filePath = path.join(IMAGE_DIR, fileName);
    await fs.promises.writeFile(filePath, buffer);
    console.log(`🖼️  Saved image to ${filePath}`);
  } catch (err) {
    console.error(`⚠️  Error saving image ${url}:`, err);
  }
}

async function processUserInput(userInput) {
  // Add user message to history
  conversationHistory.push({
    role: 'user',
    content: userInput
  });

  persistHistory(conversationHistory);

  // Track sources used in this response
  let sourcesUsed = [];

  const result = await streamText({
    model: anthropic('claude-3-5-sonnet-latest'),
    system: `You are an AI generalist assistant with access to Valyu's multimodal retrieval system.

SEARCH GUIDELINES:
1. **When to search**: Use the search tool whenever the user asks about factual information, external data, or anything you are not fully certain about.
2. **When NOT to search**: Only skip searching for simple clarifications about our conversation or follow-up questions that can be answered from previous search results.
3. **Search query handling**: When searching, use the exact terms and phrases the user mentions. Do not modify, expand, or add additional terms to their search query, especially for news-related requests.
4. **Always cite your sources**: Provide citations in the form [Source Title](URL) for statements based on search results.
5. **Response style**: Provide clear, concise answers appropriate to the domain and highlight any uncertainties or limitations.
6. **Image handling**: If images are returned, describe each in detail at the end of your response, alongside their image ID.

IMPORTANT: This tool is for informational purposes only. Encourage users to verify critical information through additional reputable sources.`,
    messages: conversationHistory,
    tools: {valyuSearchTool},
    maxSteps: 5
  })

  // Collect messages for this turn
  let assistantResponseBuffer = '';
  // we'll push tool messages directly for real-time persistence

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        process.stdout.write(`\x1b[36m${part.textDelta}\x1b[0m`);
        assistantResponseBuffer += part.textDelta;
        break;
      case 'tool-call':
        console.log(`\n\n\x1b[33m🔬 TOOL CALL: Searching Valyu for \"${part.args.query}\"\x1b[0m\n`);
        console.log('\x1b[90m' + '─'.repeat(80) + '\x1b[0m');
        conversationHistory.push({ role: 'assistant', content: [part] });
        persistHistory(conversationHistory);
        break;
      case 'tool-result':
        console.log(`\n\x1b[32m📊 TOOL RESULT (handled by SDK)\x1b[0m`);
        conversationHistory.push({ role: 'tool', content: [part] });
        persistHistory(conversationHistory);
        console.log('\x1b[90m' + '─'.repeat(80) + '\x1b[0m');
        console.log(`\n\x1b[36m🤖 AI RESPONSE:\x1b[0m`);
        break;
    }
  }

  // Final assistant text
  if (assistantResponseBuffer.trim()) {
    conversationHistory.push({ role: 'assistant', content: assistantResponseBuffer.trim() });
    persistHistory(conversationHistory);
  }

  persistHistory(conversationHistory);

  console.log('\n');
}

function askQuestion() {
  return new Promise((resolve) => {
    rl.question('\x1b[35m💬 You: \x1b[0m', (answer) => {
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('\x1b[1m\x1b[34m🤖 Welcome to the Valyu General AI Assistant!\x1b[0m');
  console.log('\x1b[90mI have access to comprehensive information across domains.\x1b[0m');
  console.log('\x1b[90mAsk me about: science, technology, history, arts, and more.\x1b[0m');
  console.log('\x1b[90mI\'ll search credible sources to give you evidence-based, cited answers.\x1b[0m');
  console.log('\x1b[91m⚠️  For educational and informational purposes only. Verify critical information from authoritative sources.\x1b[0m');
  console.log('\x1b[90mType "exit" or "quit" to end the conversation.\x1b[0m\n');

  while (true) {
    try {
      const userInput = await askQuestion();
      
      if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit' || userInput === '') {
        console.log('\x1b[34m👋 Thanks for using the Valyu General AI Assistant!\x1b[0m');
        break;
      }

      await processUserInput(userInput);
      
    } catch (error) {
      console.error('\x1b[31m❌ Error occurred:\x1b[0m', error);
    }
  }

  rl.close();
}

main().catch(console.error); 