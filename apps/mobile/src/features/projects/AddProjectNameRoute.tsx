import type { StaticScreenProps } from "@react-navigation/native";

import { AddProjectNameScreen } from "./AddProjectScreen";
import { resolveAddProjectNameInput, type AddProjectNameRouteParams } from "./addProjectNameFlow";

export function AddProjectNameRoute({
  route,
}: StaticScreenProps<AddProjectNameRouteParams | undefined>) {
  return <AddProjectNameScreen input={resolveAddProjectNameInput(route.params)} />;
}
