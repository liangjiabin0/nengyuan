# Data, Code, and Reproduction Availability Audit

## Availability questions

Check whether the manuscript gives:

- data source and public/private status;
- repository, DOI, URL, access request path;
- dataset version, site/region, period;
- sample counts and schema;
- train/validation/test split construction;
- preprocessing and missing-data handling;
- code repository and commit/release/version;
- environment/dependencies;
- model/config/checkpoint availability;
- supplementary materials.

## Restricted engineering data

Do not automatically penalize confidentiality. Require enough substitute information to audit the method:

- field definitions;
- anonymized statistics/ranges;
- collection process;
- representative samples;
- synthetic/benchmark substitute;
- transformation/preprocessing steps.

## Principle-level reproduction

Exact numerical replication is optional unless full author artifacts are available. Principle-level reproduction should test whether the described mechanism is executable and behaves consistently with the paper's logic.

Report:

- data used by reviewer;
- reviewer assumptions;
- reconstructed workflow;
- observed qualitative mechanism/trend;
- missing details that forced guesses;
- impact of those guesses on conclusions.

## Identity and reconstructability

Apply M15 in [power-system-review-memory.md](power-system-review-memory.md). An anonymized system name is not itself a scientific flaw. Identify the specific unavailable parameter, data field, operating boundary or provenance that blocks verification, and permit an anonymous or public substitute adequate to the claim. Record data/code status separately; absence of one does not imply absence of the other.
