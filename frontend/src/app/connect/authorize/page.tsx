import { AiConsent } from "@/components/settings/ai-consent";

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string }>;
}) {
  const params = await searchParams;
  return (
    <AiConsent
      authorizationId={typeof params.authorization_id === "string" ? params.authorization_id : null}
    />
  );
}
