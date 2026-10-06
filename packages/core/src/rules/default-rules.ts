/**
 * Default detector rules. Data-driven: add an entry to extend detection.
 * `callee` regexes match the whitespace-stripped callee text of a call/new expression (e.g. `client.messages.create`).
 * `table` (optional) is a regex whose first capture group extracts a table/model name from the full call text.
 */
export type Lang = 'js' | 'py';
export interface CallRule { id: string; kind: 'llm' | 'sql'; callee: RegExp; confidence: number; langs?: Lang[]; table?: RegExp; style?: 'raw' | 'orm'; op?: 'read' | 'write' }
export interface FileRule { id: string; kind: 'llm' | 'sql'; path: RegExp; confidence: number }
export interface Rules {
  calls: CallRule[];
  files: FileRule[];
  /** Strong prompt markers for long string literals. */
  promptMarkers: RegExp[];
  promptMinLength: number;
  /** Raw SQL statement openers checked against string literals. */
  sqlStatements: RegExp[];
  /** ORM method names that imply a write. */
  writeMethods: RegExp;
}

export const defaultRules: Rules = {
  calls: [
    // ---- LLM SDKs ----
    { id: 'anthropic.messages', kind: 'llm', callee: /(^|\.)messages\.(create|stream|countTokens)$/, confidence: 0.95 },
    { id: 'openai.chat', kind: 'llm', callee: /(^|\.)chat\.completions\.(create|parse|stream)$/, confidence: 0.95 },
    { id: 'openai.responses', kind: 'llm', callee: /(^|\.)responses\.(create|stream|parse)$/, confidence: 0.9 },
    { id: 'openai.completions', kind: 'llm', callee: /(^|\.)ChatCompletion\.create$|^openai\.completions\.create$/, confidence: 0.9 },
    { id: 'vercel-ai', kind: 'llm', callee: /^(generateText|streamText|generateObject|streamObject)$/, confidence: 0.9, langs: ['js'] },
    { id: 'langchain.model', kind: 'llm', callee: /(^|\.)(ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI|ChatOllama|AzureChatOpenAI|ChatBedrock)$/, confidence: 0.85 },
    { id: 'langchain.prompt', kind: 'llm', callee: /(^|\.)(ChatPromptTemplate|PromptTemplate)(\.(fromMessages|fromTemplate|from_messages|from_template))?$|(^|\.)(SystemMessage|HumanMessage|SystemMessagePromptTemplate)$/, confidence: 0.85 },
    { id: 'gemini', kind: 'llm', callee: /(^|\.)(generate_content|generateContent|generateContentStream)$/, confidence: 0.85 },
    { id: 'litellm', kind: 'llm', callee: /^(litellm\.)?(completion|acompletion)$/, confidence: 0.6, langs: ['py'] },
    // ---- ORMs ----
    { id: 'prisma', kind: 'sql', style: 'orm', callee: /(^|\.)prisma\.(\w+)\.(findMany|findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)$/, table: /prisma\s*\.\s*(\w+)\s*\./, confidence: 0.9, langs: ['js'] },
    { id: 'prisma.raw', kind: 'sql', style: 'raw', callee: /\$(queryRaw|executeRaw)(Unsafe)?$/, confidence: 0.9, langs: ['js'] },
    { id: 'knex', kind: 'sql', style: 'orm', callee: /^knex(\.(select|insert|update|del|delete|raw|schema\.\w+))?$/, table: /^knex\s*\(\s*['"`](\w+)/, confidence: 0.8, langs: ['js'] },
    { id: 'drizzle', kind: 'sql', style: 'orm', callee: /^(db|tx)\.(select|insert|update|delete)$/, table: /\.(?:insert|update|delete)\s*\(\s*(\w+)/, confidence: 0.6, langs: ['js'] },
    { id: 'typeorm', kind: 'sql', style: 'orm', callee: /(^|\.)(getRepository|createQueryBuilder)$|Repository\.(find|findOne|findBy|save|remove|delete|update|insert)$/, table: /getRepository\s*\(\s*(\w+)/, confidence: 0.75, langs: ['js'] },
    { id: 'sqlalchemy', kind: 'sql', style: 'orm', callee: /(^|\.)session\.(query|execute|add|add_all|delete|merge|scalars)$/, table: /\.(?:query|add|delete)\s*\(\s*(\w+)/, confidence: 0.75, langs: ['py'] },
    { id: 'django', kind: 'sql', style: 'orm', callee: /^([A-Z]\w*)\.objects\.(\w+)$/, table: /^([A-Z]\w*)\.objects/, confidence: 0.85, langs: ['py'] },
  ],
  files: [
    { id: 'sql-file', kind: 'sql', path: /\.sql$/i, confidence: 0.95 },
    { id: 'prompt-file', kind: 'llm', path: /\.prompt$|\.jinja2?$|\.j2$/i, confidence: 0.85 },
    { id: 'prompts-dir', kind: 'llm', path: /(^|\/)prompts?\/[^/]+\.(md|txt|mdx)$/i, confidence: 0.85 },
  ],
  promptMarkers: [/\bYou are (a|an|the)\b/i, /\bRespond (only )?(in|with) (valid )?JSON\b/i, /\{\{\s*[\w.]+\s*\}\}/, /^\s*(system|user|assistant|human)\s*:/im, /\bYour task is\b/i, /<\/?(instructions|context|system)>/i],
  promptMinLength: 200,
  sqlStatements: [/\bSELECT\b[\s\S]+?\bFROM\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+[\w."`\[\]]+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bCREATE\s+(TABLE|INDEX|VIEW)\b/i],
  writeMethods: /^(create\w*|insert\w*|update\w*|upsert|delete\w*|del|save|remove|add|add_all|merge|bulk_\w+|get_or_create|update_or_create|executeRaw\w*)$/i,
};
