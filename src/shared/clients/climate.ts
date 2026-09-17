import axios from "axios";
import { env } from "@/shared/utils";

export const climateDataClient = axios.create({
  baseURL: env.CLIMATE_DATA_BASE_URL,
});
