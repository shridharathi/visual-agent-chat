/* Small arithmetic evaluator for the calculate tool. Workers can't eval(), and a parser is safer anyway.
 * Grammar: expr = term (("+"|"-") term)*; term = unary (("*"|"/"|"%") unary)*; unary = ("-"|"+") unary | power;
 * power = atom ("^" unary)?; atom = number | "(" expr ")". So -2^2 = -4 and 2^-1 = 0.5, as in math. */
export function calculate(src: string): number {
  const s = src.replace(/\s+/g, "").replace(/\*\*/g, "^");
  let i = 0;
  const fail = (msg: string): never => { throw new Error(msg); };
  const expr = (): number => {
    let v = term();
    while (s[i] === "+" || s[i] === "-") v = s[i++] === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (s[i] === "*" || s[i] === "/" || s[i] === "%") {
      const op = s[i++], r = unary();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const power = (): number => {
    const b = atom();
    if (s[i] === "^") { i++; return b ** unary(); }
    return b;
  };
  const unary = (): number => {
    if (s[i] === "-") { i++; return -unary(); }
    if (s[i] === "+") { i++; return unary(); }
    return power();
  };
  const atom = (): number => {
    if (s[i] === "(") { i++; const v = expr(); if (s[i++] !== ")") fail("Missing )"); return v; }
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (!m) fail(i < s.length ? `Unexpected "${s[i]}"` : "Expression ended early");
    i += m![0].length;
    return parseFloat(m![0]);
  };
  if (!s) fail("Empty expression");
  const v = expr();
  if (i < s.length) fail(`Unexpected "${s[i]}"`);
  if (!Number.isFinite(v)) fail("Result is not a finite number");
  return Math.round(v * 1e10) / 1e10;
}
