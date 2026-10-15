-- Usuarios seed (docs/spec.md §1). Los ids son fijos porque payments-service los usa como owner_id de
-- ACC-001 (alice), ACC-002 (bob) y ACC-003 (carol).
-- Contraseña de los tres: Demo1234! — hashes bcrypt coste 10, cada uno con su propio salt.
INSERT INTO auth_schema.users (id, email, password_hash) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@demo.co', '$2b$10$UcCzFcXqo7VLAPKyQlR83eCXEOkyK.d.b6AtJSRHzQRgV293wSH1G'),
  ('22222222-2222-2222-2222-222222222222', 'bob@demo.co',   '$2b$10$TnAWOXzNN9fMzy7B4DejXOfymHyEKFKw/Uqv/IxZEym4inVuG5B/G'),
  ('33333333-3333-3333-3333-333333333333', 'carol@demo.co', '$2b$10$MXKv/QKWShvSApv7RURyrOghYA4MsTN3qVjuYSuPHyk8lflBAnNOq')
ON CONFLICT DO NOTHING;
