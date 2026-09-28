/**
 * templateService.test.ts
 *
 * Unit tests for the Handlebars template rendering service.
 *
 * Covers:
 *  - Happy path: renders a valid template with the correct variables
 *  - Missing template: throws TemplateNotFoundError for unknown event types
 *  - Cache: compiled template is reused on repeated calls (same file ref)
 *  - Template content: rendered HTML contains expected interpolated values
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EmailEventType } from '../../schemas/emailSchema';

// We mock the fs module so tests run without needing real template files on disk.
vi.mock('node:fs');

const mockedFs = vi.mocked(fs);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a minimal but valid Handlebars template string for testing. */
function makeTemplate(eventType: string): string {
  return `<html><body><p>Hello {{guestName}} — {{eventType}} — Code: {{reservationCode}}</p></body></html>`;
}

function setupFsMock(eventType: EmailEventType, template: string): void {
  mockedFs.existsSync.mockImplementation((filePath) => {
    return typeof filePath === 'string' && filePath.includes(eventType);
  });
  mockedFs.readFileSync.mockImplementation((filePath) => {
    if (typeof filePath === 'string' && filePath.includes(eventType)) {
      return template;
    }
    throw new Error(`ENOENT: no such file: ${String(filePath)}`);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('templateService — renderTemplate', () => {
  beforeEach(async () => {
    // Reset mocks and clear template cache between tests
    vi.clearAllMocks();
    const { clearTemplateCache } = await import('../../services/templateService');
    clearTemplateCache();
  });

  it('renders a template with interpolated variables', async () => {
    const { renderTemplate } = await import('../../services/templateService');
    const template = makeTemplate(EmailEventType.RESERVA_CONFIRMADA);
    setupFsMock(EmailEventType.RESERVA_CONFIRMADA, template);

    const data = {
      guestName:       'Carlos Drummond',
      eventType:       EmailEventType.RESERVA_CONFIRMADA,
      reservationCode: 'RES-999',
    };

    const html = renderTemplate(EmailEventType.RESERVA_CONFIRMADA, data);

    expect(html).toContain('Carlos Drummond');
    expect(html).toContain('RESERVA_CONFIRMADA');
    expect(html).toContain('RES-999');
  });

  it('throws TemplateNotFoundError when template file does not exist', async () => {
    const { renderTemplate, TemplateNotFoundError } = await import('../../services/templateService');

    mockedFs.existsSync.mockReturnValue(false);

    // Use a cast to bypass the TypeScript enum check for the "unknown" type test
    expect(() =>
      renderTemplate('UNKNOWN_EVENT_TYPE' as EmailEventType, { guestName: 'Test' }),
    ).toThrow(TemplateNotFoundError);
  });

  it('TemplateNotFoundError carries the correct eventType', async () => {
    const { renderTemplate, TemplateNotFoundError } = await import('../../services/templateService');

    mockedFs.existsSync.mockReturnValue(false);

    try {
      renderTemplate(EmailEventType.RESERVA_CANCELADA, {});
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateNotFoundError);
      if (err instanceof TemplateNotFoundError) {
        expect(err.eventType).toBe(EmailEventType.RESERVA_CANCELADA);
      }
    }
  });

  it('reads the template file only once and serves subsequent calls from cache', async () => {
    const { renderTemplate } = await import('../../services/templateService');
    const template = makeTemplate(EmailEventType.PAGAMENTO_RECEBIDO);
    setupFsMock(EmailEventType.PAGAMENTO_RECEBIDO, template);

    const data = { guestName: 'Clarice Lispector', reservationCode: 'R-42' };

    renderTemplate(EmailEventType.PAGAMENTO_RECEBIDO, data);
    renderTemplate(EmailEventType.PAGAMENTO_RECEBIDO, data);
    renderTemplate(EmailEventType.PAGAMENTO_RECEBIDO, data);

    // readFileSync should have been called exactly once despite 3 renders
    expect(mockedFs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('renders different templates for different event types', async () => {
    const { renderTemplate } = await import('../../services/templateService');

    const templateA = '<p>Template A — {{guestName}}</p>';
    const templateB = '<p>Template B — {{guestName}}</p>';

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((filePath) => {
      if (typeof filePath === 'string' && filePath.includes('RESERVA_CONFIRMADA')) return templateA;
      if (typeof filePath === 'string' && filePath.includes('PAGAMENTO_RECEBIDO'))  return templateB;
      throw new Error('unexpected path');
    });

    const htmlA = renderTemplate(EmailEventType.RESERVA_CONFIRMADA, { guestName: 'Alice' });
    const htmlB = renderTemplate(EmailEventType.PAGAMENTO_RECEBIDO,  { guestName: 'Bob' });

    expect(htmlA).toContain('Template A');
    expect(htmlB).toContain('Template B');
  });
});
