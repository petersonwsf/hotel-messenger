/**
 * templateService.ts
 *
 * Reads, compiles, and caches Handlebars (.hbs) templates from `src/templates/`.
 *
 * Naming convention (per README §4.3):
 *   Template filename must exactly match the EmailEventType enum value.
 *   Example: EmailEventType.RESERVA_CONFIRMADA → src/templates/RESERVA_CONFIRMADA.hbs
 *
 * Behaviour on missing template:
 *   Throws `TemplateNotFoundError` — the consumer catches this and nacks the
 *   message to the DLQ instead of crashing the process.
 */

import fs from 'node:fs';
import path from 'node:path';
// fileURLToPath é obrigatório em ESM para recriar __filename e __dirname
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import { EmailEventType } from '../schemas/emailSchema.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class TemplateNotFoundError extends Error {
  public readonly eventType: EmailEventType;
  public readonly templatePath: string;

  constructor(eventType: EmailEventType, templatePath: string) {
    super(
      `Template not found for event type "${eventType}". ` +
      `Expected file: ${templatePath}`,
    );
    this.name = 'TemplateNotFoundError';
    this.eventType    = eventType;
    this.templatePath = templatePath;
  }
}

// ---------------------------------------------------------------------------
// Template cache
// ---------------------------------------------------------------------------

/** Compiled Handlebars templates keyed by EmailEventType. */
const templateCache = new Map<EmailEventType, Handlebars.TemplateDelegate>();

// Recriação de __filename e __dirname compatível com ESM (NodeNext)
// Em ESM, as variáveis globais __dirname e __filename do CJS não existem.
// import.meta.url fornece a URL do módulo atual; fileURLToPath converte para caminho de sistema de arquivos.
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/**
 * Resolve o caminho absoluto para o arquivo de template (.hbs).
 * Em desenvolvimento (tsx): __dirname aponta para src/services/
 * Em produção (node dist/):  __dirname aponta para dist/services/
 * Em ambos os casos, subimos dois níveis e entramos em src/templates/.
 */
function resolveTemplatePath(eventType: EmailEventType): string {
  // __dirname = .../services/ → sobe dois níveis → raiz do projeto
  const projectRoot = path.resolve(__dirname, '..', '..');
  return path.join(projectRoot, 'src', 'templates', `${eventType}.hbs`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders a Handlebars template for the given event type with the provided data.
 *
 * @param eventType - The email event type (determines template filename).
 * @param data      - Template variables. Sensitive fields are NOT logged.
 * @returns Compiled HTML string.
 * @throws `TemplateNotFoundError` if no .hbs file exists for the event type.
 * @throws `Error` if Handlebars compilation fails.
 */
export function renderTemplate(
  eventType: EmailEventType,
  data: Record<string, unknown>,
): string {
  // Cache hit — return compiled template without disk I/O
  let compiledTemplate = templateCache.get(eventType);

  if (!compiledTemplate) {
    const templatePath = resolveTemplatePath(eventType);

    if (!fs.existsSync(templatePath)) {
      throw new TemplateNotFoundError(eventType, templatePath);
    }

    const source = fs.readFileSync(templatePath, 'utf-8');
    compiledTemplate = Handlebars.compile(source);
    templateCache.set(eventType, compiledTemplate);

    logger.debug('Template loaded and cached', { eventType, templatePath });
  }

  return compiledTemplate(data);
}

/**
 * Clears the in-memory template cache.
 * Intended for use in tests only.
 */
export function clearTemplateCache(): void {
  templateCache.clear();
}
