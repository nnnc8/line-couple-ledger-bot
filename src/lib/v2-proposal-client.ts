import { api, get } from "./api";
import {
  v2ProposalDetailSchema,
  v2ProposalConfirmationSchema,
  type ReviseV2ProposalInput,
  type V2ProposalDetail,
} from "./v2-proposal-contract";

export async function getV2ProposalDetail(proposalId: string): Promise<V2ProposalDetail> {
  return v2ProposalDetailSchema.parse(await get(`/api/app/v2/proposals/${proposalId}`));
}

export async function confirmV2ProposalClient(proposalId: string) {
  return v2ProposalConfirmationSchema.parse(await api(`/api/app/v2/proposals/${proposalId}/confirm`, {}));
}

export async function cancelV2ProposalClient(proposalId: string) {
  return api(`/api/app/v2/proposals/${proposalId}/cancel`, {});
}

export async function reviseV2ProposalClient(proposalId: string, input: ReviseV2ProposalInput) {
  return api(`/api/app/v2/proposals/${proposalId}/revise`, input);
}
