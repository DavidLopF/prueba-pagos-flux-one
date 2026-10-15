-- Datos iniciales (docs/spec.md §1). owner_id = ids fijos de los usuarios seed de auth-service.
INSERT INTO payment_schema.accounts (id, owner_id, balance) VALUES
  ('ACC-001', '11111111-1111-1111-1111-111111111111', 1000000.00),
  ('ACC-002', '22222222-2222-2222-2222-222222222222', 500000.00),
  ('ACC-003', '33333333-3333-3333-3333-333333333333', 0.00)
ON CONFLICT (id) DO NOTHING;
