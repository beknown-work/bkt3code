// T3-CUSTOM(expbkt3): the thread screen's entry point into plan review.
//
// Self-contained on purpose. It resolves its own capability, document list and
// visibility, and renders null whenever plan review does not apply, so the seam
// inside the upstream thread screen stays a single element with no surrounding
// conditional. That keeps the next upstream merge cheap.
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironmentServerConfig } from "../../state/entities";
import { planReviewEnvironment } from "../../state/planReview";
import { useEnvironmentQuery } from "../../state/query";
import { resolveOpenPlanReviewDocument, shouldOfferPlanReview } from "./planReviewAvailability";

export function PlanReviewThreadBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly hasActionableProposedPlan: boolean;
}) {
  const navigation = useNavigation();
  const iconTint = String(useThemeColor("--color-icon"));
  // Per-environment rather than the whole configs map: this banner sits on the
  // thread screen and should not re-render when an unrelated environment's
  // config changes.
  const serverConfig = useEnvironmentServerConfig(props.environmentId);
  const capabilities = serverConfig?.environment.capabilities;

  // Only ask the server for documents once the two cheap gates pass; a thread
  // with no plan awaiting review should cost no RPC at all.
  const isPossible = capabilities?.planReview === true && props.hasActionableProposedPlan;
  const documentsQuery = useEnvironmentQuery(
    isPossible
      ? planReviewEnvironment.list({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  );

  const documents = documentsQuery.data?.documents ?? null;
  const offered = shouldOfferPlanReview({
    capabilities,
    hasActionableProposedPlan: props.hasActionableProposedPlan,
    documents,
  });
  const document = resolveOpenPlanReviewDocument(documents);

  const handleOpen = useCallback(() => {
    if (document === null) return;
    navigation.navigate("ThreadPlanReview", {
      environmentId: props.environmentId,
      threadId: props.threadId,
      documentId: document.documentId,
    });
  }, [document, navigation, props.environmentId, props.threadId]);

  if (!offered || document === null) return null;

  return (
    <Pressable
      className="mx-4 mb-3 flex-row items-center gap-3 rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 py-3"
      onPress={handleOpen}
    >
      <SymbolView name="list.bullet.rectangle" size={16} tintColor={iconTint} type="monochrome" />
      <View className="flex-1">
        <Text className="text-sm font-t3-bold text-violet-700 dark:text-violet-300">
          Plan ready for review
        </Text>
        <Text className="text-xs text-violet-700/80 dark:text-violet-300/80" numberOfLines={1}>
          {document.title}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColor={iconTint} type="monochrome" />
    </Pressable>
  );
}
