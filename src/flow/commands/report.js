/** Public report acquisition facade; rendering is a pure operation. */
import { generateReport as formatReport } from "../lib/report-format.js";
import { relativeFlowSpecFile } from "../../lib/flow-workspace.js";
export { ReportBinding, ReportBindingError } from "../lib/report-binding.js";
export function generateReport(input) {
  return formatReport({ ...input, specPath: input.state?.specId ? relativeFlowSpecFile(input.state) : null });
}
