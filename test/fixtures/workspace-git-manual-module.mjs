export async function createWorkspaceGitManualCompositionFromStateRoot(options) {
  if (typeof options?.stateRoot !== "string" || !options.stateRoot.startsWith("/")) {
    throw new Error("invalid fixture state root");
  }
  return {
    contract_version: 1,
    human_decision_broker_factory: {
      contract_version: 1,
      create() {
        return {
          contract_version: 1,
          async recordHumanDecision(input) {
            if (
              input?.version !== 1 ||
              typeof input?.delivery_id !== "string" ||
              "scope" in input ||
              "approval_authority_id" in input ||
              "signature" in input ||
              "profile_id" in input
            ) {
              throw new Error("invalid fixture decision");
            }
            return {
              version: 1,
              status: input.decision === "approve" ? "approved" : "rejected",
              disposition: "transitioned",
            };
          },
        };
      },
    },
    async close() {},
  };
}
