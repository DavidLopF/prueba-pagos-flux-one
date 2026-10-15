-- Tablas de auth-service. El esquema auth_schema y el rol auth_user los crea db/init (no se crean aquí).

CREATE TABLE auth_schema.users (
  id            uuid PRIMARY KEY,
  -- Se guarda normalizado en minúsculas; el CHECK impide que se cuele un email sin normalizar.
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  -- Hash bcrypt; la contraseña en claro nunca se persiste.
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_schema.refresh_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth_schema.users (id) ON DELETE CASCADE,
  -- SHA-256 (hex) del token opaco que tiene el cliente; el token en claro nunca se persiste.
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  -- NULL = activo. Se rellena al rotar (refresh) o al hacer logout.
  revoked_at  timestamptz NULL,
  -- Token emitido al rotar este. Si un token con replaced_by vuelve a usarse, es una reutilización (AUTH-05).
  replaced_by uuid NULL REFERENCES auth_schema.refresh_tokens (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Revocar en bloque las sesiones activas de un usuario (detección de reutilización).
CREATE INDEX refresh_tokens_active_user_idx ON auth_schema.refresh_tokens (user_id) WHERE revoked_at IS NULL;
