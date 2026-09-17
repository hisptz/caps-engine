import { listHandlerDescriptors, type HandlerDescriptor } from "@/shared/handlers/catalog.ts";

export function getHandlerCatalog(): { handlers: HandlerDescriptor[] } {
  return { handlers: listHandlerDescriptors() };
}
