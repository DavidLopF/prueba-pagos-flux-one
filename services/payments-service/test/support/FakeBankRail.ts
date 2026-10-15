import type { Money } from '../../src/domain/model/Money.js';
import type { BankRail, RailLookupResult, RailSendResult } from '../../src/domain/ports/BankRail.js';

/**
 * Riel falso con "verdad" interna: recuerda qué references procesó el banco.
 * TIMEOUT_PROCESSED = el banco la procesó pero no respondió; TIMEOUT_LOST = nunca le llegó.
 */
export type FakeSendScenario = 'ACCEPTED' | 'REJECTED' | 'UNAVAILABLE' | 'TIMEOUT_PROCESSED' | 'TIMEOUT_LOST';

export class FakeBankRail implements BankRail {
  readonly bank = new Map<string, 'ACCEPTED' | 'REJECTED'>();
  readonly calls: Array<{ operation: 'send' | 'reverse' | 'lookup'; reference: string }> = [];
  sendScenarios: FakeSendScenario[] = [];
  reversalScenarios: FakeSendScenario[] = [];
  /** Si hay elementos, sobrescriben la respuesta verdadera del lookup (p. ej. UNAVAILABLE). */
  lookupOverrides: RailLookupResult[] = [];

  async sendTransfer(request: { reference: string; from: string; to: string; amount: Money }): Promise<RailSendResult> {
    this.calls.push({ operation: 'send', reference: request.reference });
    return this.resolve(request.reference, this.sendScenarios.shift() ?? 'ACCEPTED');
  }

  async sendReversal(request: { reference: string; originalReference: string; amount: Money }): Promise<RailSendResult> {
    this.calls.push({ operation: 'reverse', reference: request.reference });
    return this.resolve(request.reference, this.reversalScenarios.shift() ?? 'ACCEPTED');
  }

  async lookup(reference: string): Promise<RailLookupResult> {
    this.calls.push({ operation: 'lookup', reference });
    return this.lookupOverrides.shift() ?? this.bank.get(reference) ?? 'NOT_FOUND';
  }

  callsFor(operation: 'send' | 'reverse' | 'lookup'): number {
    return this.calls.filter((call) => call.operation === operation).length;
  }

  private resolve(reference: string, scenario: FakeSendScenario): RailSendResult {
    const known = this.bank.get(reference);
    if (known) return known; // el banco deduplica por reference
    switch (scenario) {
      case 'ACCEPTED':
      case 'REJECTED':
        this.bank.set(reference, scenario);
        return scenario;
      case 'UNAVAILABLE':
        return 'UNAVAILABLE';
      case 'TIMEOUT_PROCESSED':
        this.bank.set(reference, 'ACCEPTED');
        return 'UNKNOWN';
      case 'TIMEOUT_LOST':
        return 'UNKNOWN';
    }
  }
}
