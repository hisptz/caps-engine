import { services, type ServiceType } from "@/shared/constants/service.ts";

export function getServiceName(key: ServiceType) {
  return services.get(key)?.name as string;
}
