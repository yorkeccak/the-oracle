import { streamText, tool, generateText } from "ai"
import { z } from 'zod';
import dotenv from 'dotenv'
import { Valyu } from 'valyu-js';
import { anthropic } from "@ai-sdk/anthropic"
import { openai } from "@ai-sdk/openai"
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import sharp from 'sharp';
import terminalImage from 'terminal-image';

// Load environment variables
dotenv.config()

// ---------------------------------------------------------------------------
//  AI provider selection (Anthropic by default, fall back to OpenAI GPT-4o)
// ---------------------------------------------------------------------------

const isAnthropicAvailable = Boolean(process.env.ANTHROPIC_API_KEY);
const isOpenAIAvailable   = Boolean(process.env.OPENAI_API_KEY);

if (!isAnthropicAvailable && !isOpenAIAvailable) {
  console.error('\x1b[31m❌ No Anthropic or OpenAI API keys found in environment – please set at least one.\x1b[0m');
  process.exit(1);
}

const useAnthropic = isAnthropicAvailable; // prefer Anthropic when present

const chatModel = (modelNameAnthropic = 'claude-3-5-sonnet-latest', modelNameOpenAI = 'gpt-4o') => {
  return useAnthropic ? anthropic(modelNameAnthropic) : openai(modelNameOpenAI);
};
// ---------------------------------------------------------------------------

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

// Helper to create clickable hyperlinks using OSC-8
function makeLink(text, url) {
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}

const valyuSearchTool = tool({
    description: 'Search Valyu\'s multimodal knowledge graph for information across any domain. Use this tool whenever external factual information is needed.',
    parameters: z.object({
      query: z.string().describe('Specific, detailed search query focusing on the exact information needed'),
      maxResults: z.number().min(1).max(20).default(5).describe('Maximum number of results to return'),
    }),
    execute: async ({ query, maxResults }) => {
      try {
        const response = await valyu.search(query, {
          searchType: 'web',
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

        const formattedResults = response.results?.map((result, index) => {
          // Extract ALL images from each result
          const dict = result.image_url || {};
          const urls = Object.values(dict);
          const images = urls; // Take ALL images, not just first one
          
          const title = result.title || 'Untitled Source';
          const url = result.url || 'No URL';
          
          return {
            title,
            content: result.content,
            url: result.url,
            source: result.source,
            relevanceScore: result.relevance_score,
            images,
            citation: `[${title}]${result.url ? `(${result.url})` : ''}`
          };
        }) || [];

        // Gather ALL images from all results (up to 15 total for comprehensive coverage)
        const rawImages = formattedResults.flatMap(r => r.images);
        const imageUrls = rawImages.filter(u => {
          try {
            const ext = path.extname(new URL(u).pathname).toLowerCase();
            return ext !== '.svg' && ext !== '.svgz';
          } catch {
            return false;
          }
        }).slice(0, 15); // Increased from 5 to 15 to get more images

        // Prepare text snippets (top 5 results)
        const textSnippets = formattedResults.slice(0, 5).map((r, idx) => {
          const snippet = r.content ? r.content.slice(0, 1200) : '';
          return `SOURCE ${idx + 1}: ${r.title}\n${snippet}\n${r.citation}`;
        });

        return {
          success: true,
          texts: textSnippets,
          image_urls: imageUrls
        };
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

      // Include image URLs in a text block for the model to reference
      if (out?.image_urls && out.image_urls.length) {
        parts.push({ type: 'text', text: `IMAGE_URLS: ${out.image_urls.join(', ')}` });
      }

      if (parts.length === 0) {
        return [{ type: 'text', text: 'No relevant results.' }];
      }
      return parts;
    }
});


const analyseImagesTool = tool({
    description: 'Analyse images and provide detailed descriptions of their content.',
    parameters: z.object({
        image_urls: z.array(z.string()).describe('Array of image URLs to analyse'),
    }),
    execute: async ({ image_urls }) => {
        // Determine the most recent search query to give the image analyser additional context
        const queryContext = getLastValyuSearchQuery();

        // Process all images in parallel for much faster execution
        const imagePromises = image_urls.map(async (url) => {
            const imageId = `IMG${globalImageID++}`;

            // Step 1: Always attempt to download the image so we can display it even if analysis fails
            const filePath = await downloadAndSaveImage(url, imageId);
            
            // Step 2: Attempt to analyse the image – if this fails, keep the filePath so it still shows in the grid
            let description;
            try {
                const result = await generateText({
                    model: chatModel(),
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: `Analyse the following image and provide a detailed description of its content, including any text, charts, diagrams, or visual elements.${queryContext ? ` This image was returned for the web search query: "${queryContext}".` : ''}` },
                                { type: 'image', image: url }
                            ]
                        }
                    ]
                });
                // Remove any leading IMGx: prefix that the model might include
                description = result.text.trim().replace(/^IMG\d+\s*:*/i, '').trim();
            } catch (error) {
                description = 'Hmm, can&apos;t see anything here.';
            }

            return {
                id: imageId,
                url,
                filePath,
                description
            };
        });

        // Wait for all image analyses to complete
        const imageAnalyses = await Promise.all(imagePromises);

        // Display images along with their descriptions
        const imagePaths = imageAnalyses.map(img => img.filePath);
        const imageIds = imageAnalyses.map(img => img.id);
        const imageDescriptions = imageAnalyses.map(img => img.description);
        await displayImagesInGrid(imagePaths, imageIds, imageDescriptions);

        console.log(`\x1b[92m✅ Completed analysis of ${imageAnalyses.length} images\x1b[0m`);

        return {
            success: true,
            images: imageAnalyses,
            analyzed_count: imageAnalyses.length
        };
    }
})


// Store conversation history
let conversationHistory = [];

// Utility: find the most recent Valyu search query so we can provide context to image analysis
function getLastValyuSearchQuery() {
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const entry = conversationHistory[i];
    if (entry.role === 'assistant' && Array.isArray(entry.content)) {
      const part = entry.content[0];
      if (part && part.toolName === 'valyuSearchTool' && part.args && part.args.query) {
        return part.args.query;
      }
    }
  }
  return null;
}

async function downloadAndSaveImage(url, imageId) {
  try {
    // Downloading image (silent)
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Try to get extension from URL, fallback to .jpg
    let ext = '.jpg';
    try {
      const urlExt = path.extname(new URL(url).pathname);
      if (urlExt) ext = urlExt;
    } catch (e) {
      // Keep default .jpg if URL parsing fails
    }
    
    const fileName = `${imageId}${ext}`;
    const filePath = path.join(IMAGE_DIR, fileName);
    await fs.promises.writeFile(filePath, buffer);
    
    // Image saved successfully (silent)
    return filePath; // Return file path for grid display
    
  } catch (err) {
    console.error(`⚠️  Error saving ${imageId} from ${url}:`, err.message);
    return null;
  }
}

async function displayImagesInGrid(imagePaths, imageIds, imageDescriptions = []) {
  // Filter out any null paths while keeping ids & descriptions aligned
  const validImages = [];
  const validIds = [];
  const validDescs = [];
  for (let i = 0; i < imagePaths.length; i++) {
    if (imagePaths[i]) {
      validImages.push(imagePaths[i]);
      validIds.push(imageIds[i]);
      validDescs.push(imageDescriptions[i] || '');
    }
  }
   
  if (validImages.length === 0) {
    console.log('No images to display');
    return;
  }

  // Dynamically adjust based on terminal size
  const terminalWidth = process.stdout.columns || 120; // fallback to 120 if not available
  const minImageWidth = 30; // minimum width for readability
  const maxImageWidth = 80; // maximum width to prevent huge images
  const spacing = 2; // space between columns
  
  // Calculate optimal layout
  let cols = 1;
  let imageWidth = Math.min(maxImageWidth, Math.max(minImageWidth, terminalWidth - 10));
  
  // Try 2 columns if terminal is wide enough
  if (terminalWidth >= (minImageWidth * 2 + spacing + 10)) {
    cols = 2;
    imageWidth = Math.min(maxImageWidth, Math.floor((terminalWidth - spacing - 10) / 2));
  }
  
  // Try 3 columns if terminal is very wide
  if (terminalWidth >= (minImageWidth * 3 + spacing * 2 + 10)) {
    cols = 3;
    imageWidth = Math.min(maxImageWidth, Math.floor((terminalWidth - spacing * 2 - 10) / 3));
  }
  
  const separatorWidth = Math.min(terminalWidth, 120);
  
  console.log('Preview of images (terminal rendering may appear pixelated)');
  console.log('═'.repeat(separatorWidth));
  
  // Use global makeLink helper for clickable labels
  
  for (let i = 0; i < validImages.length; i += cols) {
    const rowImages = validImages.slice(i, i + cols);
    const rowIds = validIds.slice(i, i + cols);
    const rowDescs = validDescs.slice(i, i + cols);
    
    // Generate terminal images for this row
    const termImages = [];
    const labels = [];
    
    for (let j = 0; j < rowImages.length; j++) {
      try {
        const termImage = await terminalImage.file(rowImages[j], { 
          width: imageWidth, 
          preserveAspectRatio: true 
        });
        termImages.push(termImage.split('\n'));
        const fileName = path.basename(rowImages[j]);
        const plainLabel = `${rowIds[j]} (${fileName})`;
        const linkedLabel = makeLink(plainLabel, `file://${rowImages[j]}`);
        const paddedLabel = linkedLabel + ' '.repeat(Math.max(0, imageWidth - plainLabel.length));
        labels.push(paddedLabel);
      } catch (error) {
        // Show file path instead of broken image
        const base = path.basename(rowImages[j]);
        const plainLabelErr = `${rowIds[j]} (${base})`;
        const paddedErr = plainLabelErr.padEnd(imageWidth);
        labels.push(paddedErr);
      }
    }
    
    // Display labels (image IDs)
    console.log(labels.join('  '));

    // Display images side by side
    const maxLines = Math.max(...termImages.map(img => img.length));
    for (let line = 0; line < maxLines; line++) {
      const rowLine = termImages.map(img => (img[line] || ''.padEnd(imageWidth))).join('  ');
      console.log(rowLine);
    }

    // Display descriptions below the images (wrap to max 3 lines per image)
    const MAX_DESC_LINES = 3;

    // Helper to wrap text to given width
    const wrapText = (text, width) => {
      const words = text.replace(/\n/g, ' ').split(/\s+/);
      const lines = [];
      let current = '';
      words.forEach(word => {
        if ((current + ' ' + word).trim().length > width) {
          lines.push(current.trim());
          current = word;
        } else {
          current += ' ' + word;
        }
      });
      if (current.trim()) lines.push(current.trim());
      return lines;
    };

    // Pre-wrap each description
    const wrappedDescs = rowDescs.map(desc => {
      const lines = wrapText(desc, imageWidth);
      if (lines.length > MAX_DESC_LINES) {
        const truncated = lines.slice(0, MAX_DESC_LINES);
        // Append ellipsis to last line to indicate truncation
        truncated[MAX_DESC_LINES - 1] = truncated[MAX_DESC_LINES - 1].slice(0, imageWidth - 3).padEnd(imageWidth - 3) + '...';
        return truncated;
      }
      return lines;
    });

    const maxDescLines = Math.max(...wrappedDescs.map(arr => arr.length));

    for (let dl = 0; dl < maxDescLines; dl++) {
      const lineStr = wrappedDescs.map(lines => {
        const txt = lines[dl] || '';
        return txt.padEnd(imageWidth);
      }).join('  ');
      console.log(lineStr);
    }

    console.log(''); // Empty line between rows
  }
  
  console.log('═'.repeat(separatorWidth));
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

  // Prepare history for the model: OpenAI cannot handle tool-call messages, so filter them out
  const messagesForModel = isAnthropicAvailable ? conversationHistory : conversationHistory.filter(m => {
    return (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
  });

  const result = await streamText({
    model: chatModel(),
    system: `Today's date is ${new Date().toLocaleDateString()}. You are an AI generalist assistant with access to Valyu's comprehensive multimodal search system that covers all domains of knowledge.

SEARCH GUIDELINES:
1. **When to search**: Use the search tool whenever the user asks about factual information, current events, research, or anything requiring up-to-date or specialized knowledge across any domain.
2. **When NOT to search**: Only skip searching for simple clarifications about our conversation or follow-up questions that can be answered from previous search results.
3. **Search query handling**: When searching, use the exact terms and phrases the user mentions. Do not modify, expand, or add additional terms to their search query.
4. **Always cite your sources**: Provide citations in the form [Source Title](URL) for statements based on search results.
5. **Response style & depth**: Provide clear, **thorough** answers. Aim for multi-paragraph (500-1000 words) explanations that cover background, key developments, nuanced perspectives, and implications. Where helpful, structure with short sub-headings or bullet lists. Highlight uncertainties or scholarly debates.
6. **Multiple searches**: For broad or multi-faceted questions, run several focused searches (2–4) instead of one long query. Break the topic into clear sub-queries, call \`valyuSearchTool\` separately for each, then combine and synthesize the information.
   EXAMPLE: If the user asks "Explain Japan's history and culture", you might
     a. Search "Japan history timeline"
     b. Search "Japanese culture traditions"
     c. Search "modern Japanese society demographics"
     After gathering results from all searches, integrate them into a single, coherent answer.
     IMPORTANT: Do not make multiple searches in parallel.
7. **MANDATORY image-handling workflow (no exceptions)**:
    1) **Collect** every image URL from every \`valyuSearchTool\` result in this turn – *do not drop or skip any*.
    2) **Exactly once per turn**, **BEFORE** you start writing an explanatory answer, you **MUST** invoke \`analyseImagesTool\` with the **UNION of **ALL** collected URLs**.  
    3) After the analysis tool(s) finish:
        • **Weave insights directly into your narrative** – cite or describe the relevant image inline (e.g., "As shown in IMG3, …").  
        • **Then add an "Image Appendix" at the end**: list every IMG# with a concise (≤ 2-line) description so readers can quickly reference each visual.

🚫 **If you produce any narrative text before analysing every image, or if you omit even a single image URL, the response will be considered INVALID.**

IMPORTANT: This tool is for informational and educational purposes only. Encourage users to verify critical information through additional authoritative sources and consult relevant experts for professional advice.`,
    messages: messagesForModel,
    tools: {valyuSearchTool, analyseImagesTool},
    maxSteps: 15
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
        // Handle different tool call types
        if (part.toolName === 'valyuSearchTool') {
          console.log(`\n\n\x1b[33m🔬 TOOL CALL: Searching Valyu for \"${part.args.query}\"\x1b[0m\n`);
        } else if (part.toolName === 'analyseImagesTool') {
          console.log(`\n\n\x1b[33m🖼️  TOOL CALL: Analyzing ${part.args.image_urls?.length || 0} image(s)\x1b[0m\n`);
        } else {
          console.log(`\n\n\x1b[33m🔧 TOOL CALL: ${part.toolName}\x1b[0m\n`);
        }
        console.log('\x1b[90m' + '─'.repeat(80) + '\x1b[0m');
        conversationHistory.push({ role: 'assistant', content: [part] });
        persistHistory(conversationHistory);
        break;
      case 'tool-result':
        console.log(`\n\x1b[32m📊 TOOL RESULT\x1b[0m`);
        
        // Extract and collect sources for references section
        try {
          if (part.toolName === 'valyuSearchTool' && part.result && part.result.texts) {
            console.log(`\x1b[32m📚 Found sources:\x1b[0m`);
            part.result.texts.forEach((text, idx) => {
              // Extract title and URL from the formatted text
              const lines = text.split('\n');
              const sourceLine = lines[0]; // "SOURCE 1: Title"
              const citationLine = lines.find(line => line.startsWith('[') && line.includes(']('));
              
              if (sourceLine && citationLine) {
                const title = sourceLine.replace(/SOURCE \d+: /, '');
                const urlMatch = citationLine.match(/\]\(([^)]+)\)/);
                const url = urlMatch ? urlMatch[1] : '';
                
                console.log(`\x1b[32m   ${idx + 1}. ${title}\x1b[0m`);
                console.log(`\x1b[90m      ${url}\x1b[0m`);
                
                // Collect source for references section
                sourcesUsed.push({
                  title: title,
                  url: url
                });
              }
            });
          }
        } catch (e) {
          // If parsing fails, just continue
        }
        
        conversationHistory.push({ role: 'tool', content: [part] });
        persistHistory(conversationHistory);
        console.log('\x1b[90m' + '─'.repeat(80) + '\x1b[0m');
        break;
    }
  }

  // Final assistant text
  if (assistantResponseBuffer.trim()) {
    conversationHistory.push({ role: 'assistant', content: assistantResponseBuffer.trim() });
    persistHistory(conversationHistory);
  }

  // Add references section if sources were used
  if (sourcesUsed.length > 0) {
    console.log('\n\n\x1b[93mREFERENCES:\x1b[0m');
    sourcesUsed.forEach((source, idx) => {
      const linked = makeLink(source.title, source.url);
      console.log(`\x1b[93m${idx + 1}. ${linked}\x1b[0m`);
    });
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
  console.log('\x1b[1m\x1b[34m👁️  The Oracle - See the Full Picture\x1b[0m');
  console.log('\x1b[90mAI News & Research Assistant That Can See\x1b[0m');
  console.log('\x1b[90m🔍 I search the web for real-time information and analyze images to give you complete context.\x1b[0m');
  console.log('\x1b[90m📊 Perfect for: breaking news, research analysis, visual content understanding, fact-checking\x1b[0m');
  console.log('\x1b[90m🎯 I don\'t just read headlines - I see charts, photos, diagrams and extract insights from visuals!\x1b[0m');
  console.log('\x1b[91m⚠️  For informational purposes only. Always verify critical information from primary sources.\x1b[0m');
  console.log('\x1b[90mType "exit" or "quit" to end the conversation.\x1b[0m\n');

  while (true) {
    try {
      const userInput = await askQuestion();
      
      if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit' || userInput === '') {
        console.log('\x1b[34m👋 Thanks for using ValyuVision - stay informed and see the full picture!\x1b[0m');
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