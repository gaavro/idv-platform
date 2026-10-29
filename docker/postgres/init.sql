-- The API connects as idv_app, a role without superuser or BYPASSRLS,
-- so row-level security applies to every query it makes.
CREATE ROLE idv_app LOGIN PASSWORD 'idv_app';

CREATE DATABASE idv_test OWNER idv_owner;
