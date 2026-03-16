import { DeclaredPositionEditor } from "./DeclaredPositionEditor";

interface DarwinDeclaredPositionProps {
  claimId: string;
  claim: any;
}

export const DarwinDeclaredPosition = ({ claimId, claim }: DarwinDeclaredPositionProps) => {
  return <DeclaredPositionEditor claimId={claimId} claim={claim} />;
};
