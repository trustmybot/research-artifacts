// Imported before ../gcp/common.ts, so a checkout without harness/gcp/infra.local.json loads these values instead of
// the placeholders that make every --yes command refuse. A local file still wins, as it does outside tests.
process.env.TMB_GCP_PROJECT = "test-gcp-project";
process.env.TMB_GCP_ACCOUNT = "tester@example.com";
process.env.TMB_VAULT_REPO = "example-org/test-vault";
