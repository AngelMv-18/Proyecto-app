-- Movimientos detectados cuya cuenta es una suposición: la app pregunta de qué tarjeta o cuenta son antes de confirmar.
ALTER TABLE transactions ADD COLUMN account_pending boolean NOT NULL DEFAULT false;
-- Aviso para quien revisa (p. ej. "importe estimado: el cobro fue en USD").
ALTER TABLE transactions ADD COLUMN review_hint text;
