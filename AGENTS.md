# The Oracle – Architecture & Agent Design

## Overview
**The Oracle** is a terminal-native multimodal AI agent that combines Valyu's real-time DeepSearch API with vision-capable LLMs to deliver fully-cited answers enriched with image insight. Runs entirely in the CLI and shows pixel-art previews of every image it analyses.

## Repository Structure

```
the-oracle/
├── agent.js                    # Main application entry point
├── package.json               # Project dependencies and metadata
├── package-lock.json          # Locked dependency versions
├── README.md                  # User-facing documentation
├── conversation_history.json  # Persistent conversation storage
├── downloaded_images/         # Local image storage directory
├── .gitignore                # Git ignore patterns
└── AGENTS.md                 # This architecture document
```

## Current Features & Architecture

### Core Components

#### 1. Main Agent (`agent.js`)
- **Entry Point**: Node.js CLI application using readline interface
- **AI Provider Selection**: Prefers **Anthropic Claude 3.5 Sonnet**; if `ANTHROPIC_API_KEY` missing but `OPENAI_API_KEY` provided it auto-switches to **OpenAI GPT-4o**.
- **Framework**: Vercel AI SDK with streaming & tool-calling.
- **Environment Vars**: `VALYU_API_KEY` plus **either** `ANTHROPIC_API_KEY` *or* `OPENAI_API_KEY`.
- **Conversation History**: Stores full JSON (including tool events) but filters schema-incompatible messages when talking to OpenAI.

#### 2. Tool System
The agent uses two primary tools:

##### `valyuSearchTool`
- **Purpose**: Search Valyu's multimodal knowledge graph across all domains
- **Configuration**:
  - `searchType: 'web'` for real-time coverage across all domains.
  - `maxPrice: 1000` (cost limit)
  - `maxNumResults` configurable (default 5) — returns *all* images from every result (non-SVG) and surfaces up to **15 images total** for analysis.
  - Filters out `.svg/.svgz` before returning.

##### `analyseImagesTool`
- **Purpose**: Separate Claude instance for image analysis to reduce main conversation token usage
- **Input**: Array of image URLs (up to 15)
- **Context Injection**: Automatically appends the latest Valyu search query to give the vision model topical awareness.
- **Output**: JSON with `id`, `filePath`, `description` per image.
- **Provider**: Uses whichever LLM provider is active.

#### 3. Data Persistence
- **Conversation History**: Real-time JSON storage in `conversation_history.json`
- **Image Storage**: Downloads images to `downloaded_images/` with unique IDs
- **Image Processing**: Uses Sharp library for compression (768px max, 70% JPEG quality)

#### 4. User Experience
- **Streaming Output**: Real-time response display with colored output
- **Tool Call Visibility**: Clear indicators when searching ("🔬 TOOL CALL")
- **Source Attribution**: References section now renders titles as **clickable OSC-8 hyperlinks** instead of plain URLs.
- **Image Grid**: Responsive 1-3 column grid that scales with terminal width. Each label (e.g. `IMG3 (pic.jpg)`) is now a clickable `file://` link that opens the saved image.
- **Preview Heading**: Displays *"Preview of images (terminal rendering may appear pixelated)"* followed by a separator bar.

### Key Design Decisions

#### Token Management
- **Image Compression**: Sharp library reduces image size to prevent "prompt too long" errors
- **Separate Image Analysis**: Images analyzed in separate Claude calls, not embedded in main conversation
- **Diverse Image Selection**: 1 image per search result that has images, max 5 total for better topic coverage
- **Text Snippet Limits**: 600 characters per source, max 5 sources

#### Error Handling
- **Graceful Degradation**: Search failures return error messages instead of crashing
- **Image Download Failures**: Logged but don't interrupt main flow
- **Conversation Persistence**: Real-time saving prevents data loss on crashes

#### User Experience
- **Streaming Output**: Real-time response display with colored output
- **Tool Call Visibility**: Clear indicators when searching ("🔬 TOOL CALL")
- **Source Attribution**: Automatic citation formatting
- **Multi-step Reasoning**: Up to 5 tool calls per response for complex queries

## Configuration

### Environment Variables
```env
# Mandatory search key
VALYU_API_KEY=your_valyu_api_key_here

# EITHER of the following (Anthropic preferred)
ANTHROPIC_API_KEY=your_anthropic_api_key_here
# or
OPENAI_API_KEY=your_openai_api_key_here
```

### Dependencies
- `ai` - Vercel AI SDK for LLM integration
- `@ai-sdk/anthropic` - Anthropic provider
- `@ai-sdk/openai` - OpenAI provider
- `valyu-js` - Valyu search client
- `zod` - Schema validation
- `sharp` - Image processing
- `node-fetch` - HTTP requests
- `dotenv` - Environment variable loading

## Usage Patterns

### Supported Query Types
1. **Factual Research**: "What are the latest developments in quantum computing?"
2. **Comparative Analysis**: "Compare renewable energy sources by efficiency"
3. **Current Events**: "What's happening with AI regulation in Europe?"
4. **Technical Explanations**: "How does blockchain consensus work?"
5. **Historical Context**: "What led to the 2008 financial crisis?"

### Tool Call Flow
1. User asks question
2. Agent determines if search needed
3. `valyuSearchTool` called with user query
4. If images returned, `analyseImagesTool` called automatically
5. Agent synthesizes results with citations
6. Conversation persisted to JSON