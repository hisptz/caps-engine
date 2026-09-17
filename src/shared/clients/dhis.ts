import axios from "axios";
import { env } from "@/shared/utils/env.ts";

export const dhis2RestClient = axios.create({
  baseURL: `${env.DHIS2_BASE_URL}/api`,
  headers: {
    "Content-Type": "application/json",
  },
  auth: {
    username: env.DHIS2_USERNAME,
    password: env.DHIS2_PASSWORD,
  },
});
