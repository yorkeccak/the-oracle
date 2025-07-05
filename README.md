# Advanced Generalist AI Assistant Demo

> **Next-Generation Knowledge Research Tool**: An AI assistant that goes beyond typical search tools by accessing the full text of a vast corpus of global sources, not just abstracts. Get comprehensive, evidence-based answers with complete context across domains.

An interactive AI assistant that provides authoritative medical insights by searching the complete content of PubMed's vast database of peer-reviewed medical literature. Unlike standard medical search APIs that only return abstracts, this tool accesses full research papers, enabling deeper analysis and more comprehensive answers to your health and medical questions.

## What Makes This Powerful

- 🔍 **Full-Text Access**: Unlike most medical search tools that only provide abstracts, this accesses complete research papers for comprehensive analysis
- 💬 **Intelligent Synthesis**: Combines findings from multiple studies to provide nuanced, evidence-based answers
- 📚 **Complete Citations**: Direct links to full research papers, not just abstracts
- 🎯 **Context-Aware**: Understands when to search vs. when to use previous context for follow-up questions
- 🎨 **Research-Grade Interface**: Professional output with proper academic formatting
- ⚕️ **Deep Evidence Analysis**: Analyzes study methodologies, sample sizes, and statistical significance for reliable insights

## Quick Demo Setup

### 1. Get API Keys

- **Valyu API Key**: Sign up at [valyu.network](https://platform.valyu.network) to get a free API key
- **Anthropic API Key**: Get one from [console.anthropic.com](https://console.anthropic.com)

### 2. Install Dependencies

```bash
pnpm install
# or
npm install
```

### 3. Set Environment Variables

Create a `.env` file:

```env
VALYU_API_KEY=your_valyu_api_key_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

### 4. Run the Demo

```bash
node agent.js
```

## Try These Demo Questions

Ask questions about:
- Medical conditions and diseases
- Treatment protocols and medications
- Nutrition and dietary advice
- Clinical research findings
- Diagnostic procedures
- Drug interactions and side effects
- Public health and epidemiology

**Example questions to test:**
- "What are the latest treatment options for Type 2 diabetes?"
- "What does current research say about intermittent fasting for weight loss?"
- "What are the side effects and interactions of metformin?"
- "How effective is cognitive behavioral therapy for treating depression?"
- "What dietary changes are recommended for managing high cholesterol?"

Type `exit` or `quit` to end the conversation.

## How It Works

1. **Ask Any Medical Question**: The assistant intelligently determines if it needs to search for authoritative medical information
2. **Advanced Full-Text Search**: When needed, it searches through complete PubMed research papers (not just abstracts like most tools)
3. **Comprehensive Analysis**: You get detailed answers that synthesize findings from multiple studies with proper academic citations
4. **Contextual Follow-Up**: Continue the conversation with follow-up questions that build on previous research

**What sets this apart**: Most medical search APIs only return abstracts, limiting the depth of analysis. This tool's advanced search infrastructure (powered by Valyu's multimodal search technology) provides access to complete research papers, enabling deeper understanding of study methodologies, statistical analysis, and contextual findings that abstracts simply can't provide.

**Perfect for**: healthcare professionals, medical students, researchers, and anyone who needs evidence-based medical information with complete context and rigorous analysis.

## Important Disclaimer

⚠️ This tool provides information from a variety of sources and is intended for educational and research purposes only. Verify facts independently and consult subject-matter experts where applicable.

## What it looks like
![Demo Screenshot](assets/example.png)

---