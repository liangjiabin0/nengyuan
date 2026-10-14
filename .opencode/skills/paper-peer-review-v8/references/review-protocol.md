# Review Adjudication Protocol

For every decisive issue:

1. locate the exact manuscript evidence;
2. distinguish manuscript fact from reviewer inference;
3. verify whether the issue affects a central claim;
4. check whether a smaller claim or clearer disclosure can resolve it;
5. assign severity based on scientific consequence;
6. provide a minimum sufficient action and observable acceptance criterion.

Exclude unverified allegations from the verdict.

## Fatal/critical gates

Potential critical issues include:

- central evidence internally contradictory or inaccessible enough to prevent audit;
- unrecoverable leakage or invalid evaluation design;
- central method cannot be reconstructed because essential formulation steps are missing;
- claimed theorem/guarantee is mathematically false in a way that invalidates the main contribution.

## Major gates

Typical major issues:

- central claim unsupported/only partially supported;
- central reproduction requires consequential guesses;
- decisive current comparator omitted;
- important undefined variable/parameter changes the method;
- claimed engineering applicability lacks relevant engineering validation;
- claimed stability/generalization extends beyond tested/theoretically valid scope.

## Integrating reusable knowledge

Read M01–M04 in [power-system-review-memory.md](power-system-review-memory.md) for all reviews and select domain rules from the manuscript's actual methods. For each applicable rule, capture trigger, exact evidence, checked scope, outcome and linked issue IDs in `knowledge_application`. An outcome may be no issue, supported issue, conditional risk or not assessable. Treat memory as a verification procedure, not as evidence.

For human input, extract comments, accepted body and tracked insertions/deletions, interpret fragmented edits in paragraph context, and distinguish feedback implementation from author-side scientific closure. Recheck old reviewer findings and reproduction code before retaining them. Distinguish semantic errors in the printed model, verified code errors and conditional concerns. If only skill updating is requested, integrate generalizable checks without generating another full manuscript review.
