-- Ejecutado una sola vez por el entrypoint de postgres (superusuario).
-- Un rol por servicio; cada rol solo tiene privilegios sobre su propio esquema (CLAUDE.md §1).
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE payments_portal FROM PUBLIC;

CREATE ROLE auth_user LOGIN PASSWORD 'auth_pass';
CREATE ROLE payments_user LOGIN PASSWORD 'payments_pass';
CREATE ROLE audit_user LOGIN PASSWORD 'audit_pass';

GRANT CONNECT ON DATABASE payments_portal TO auth_user, payments_user, audit_user;

CREATE SCHEMA auth_schema AUTHORIZATION auth_user;
CREATE SCHEMA payment_schema AUTHORIZATION payments_user;
CREATE SCHEMA audit_schema AUTHORIZATION audit_user;

ALTER ROLE auth_user SET search_path = auth_schema;
ALTER ROLE payments_user SET search_path = payment_schema;
ALTER ROLE audit_user SET search_path = audit_schema;
