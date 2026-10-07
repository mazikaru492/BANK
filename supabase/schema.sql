-- Only schema is committed. Customer data is imported from the local SQL file.
CREATE SCHEMA IF NOT EXISTS bank;
REVOKE ALL ON SCHEMA bank FROM PUBLIC;

CREATE TABLE IF NOT EXISTS bank.kokyaku_master (
  customer_id VARCHAR(20) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  name_kana VARCHAR(255) NOT NULL,
  gender VARCHAR(10) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  postal_code VARCHAR(10) NOT NULL,
  prefecture VARCHAR(20) NOT NULL,
  address VARCHAR(255) NOT NULL,
  birth_date DATE NOT NULL
);
CREATE TABLE IF NOT EXISTS bank.kouza_master (
  account_id VARCHAR(20) PRIMARY KEY,
  branch_id VARCHAR(10) NOT NULL,
  account_number VARCHAR(20) NOT NULL,
  customer_id VARCHAR(20) NOT NULL REFERENCES bank.kokyaku_master(customer_id),
  pin VARCHAR(10) NOT NULL,
  bank_code VARCHAR(10) NOT NULL,
  balance BIGINT NOT NULL CHECK (balance >= 0),
  UNIQUE (bank_code, branch_id, account_number)
);
CREATE TABLE IF NOT EXISTS bank.torihiki_table (
  deal_id VARCHAR(20) PRIMARY KEY,
  bank_id VARCHAR(20) NOT NULL REFERENCES bank.kouza_master(account_id),
  deal_date DATE NOT NULL,
  deal_code VARCHAR(255) NOT NULL,
  price BIGINT NOT NULL CHECK (price >= 0),
  inbank_price BIGINT NOT NULL CHECK (inbank_price >= 0),
  comment VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS bank_history_account_date ON bank.torihiki_table (bank_id, deal_date DESC, deal_id DESC);
CREATE TABLE IF NOT EXISTS bank.bank_web_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  account_id VARCHAR(20) NOT NULL REFERENCES bank.kouza_master(account_id),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS bank_session_expiry ON bank.bank_web_sessions (expires_at);

ALTER TABLE bank.kokyaku_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank.kouza_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank.torihiki_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank.bank_web_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA bank FROM PUBLIC;
