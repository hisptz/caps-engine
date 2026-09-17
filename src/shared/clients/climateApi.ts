import axios from "axios";
import { env } from "@/shared/utils";

export const climateApiClient = axios.create({
  baseURL: env.CLIMATE_API_BASE_URL,
});
