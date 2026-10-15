// Dinero = string decimal (contrato: "150000.50"). Nunca se convierte a number: se valida y formatea
// manipulando el texto, así no hay errores de coma flotante.

// Mismo patrón que el schema Money de docs/openapi.yaml: entero + hasta 2 decimales con punto.
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

/** true si el monto cumple el patrón y es > 0 (basta con que tenga algún dígito distinto de 0). */
export function isValidAmount(amount: string): boolean {
  return AMOUNT_PATTERN.test(amount) && /[1-9]/.test(amount);
}

/** "150000.5" → "$ 150.000,50" (estilo es-CO: punto de miles, coma decimal, siempre 2 decimales). */
export function formatCOP(amount: string): string {
  const [integerPart = '', decimalPart = ''] = amount.split('.');
  const integer = integerPart.replace(/^0+(?=\d)/, '') || '0'; // "007" → "7"
  // Inserta un punto en cada posición seguida de un múltiplo de 3 dígitos hasta el final.
  const grouped = integer.replace(/\B(?=(\d{3})+$)/g, '.');
  const decimals = decimalPart.padEnd(2, '0').slice(0, 2);
  return `$ ${grouped},${decimals}`;
}
