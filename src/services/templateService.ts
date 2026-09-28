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

/**
 * Resolves the absolute path to a template file.
 * `__dirname` refers to dist/services/ at runtime; we resolve upwards to
 * src/templates/ at dev time and dist/templates/ in production.
 */
function resolveTemplatePath(eventType: EmailEventType): string {
  // Walk two directories up from services/ → project root, then into templates/
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
