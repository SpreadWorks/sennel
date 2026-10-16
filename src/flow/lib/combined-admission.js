export class CombinedAdmission {
  constructor(...admissions) { this.admissions = admissions.filter(Boolean); Object.freeze(this.admissions); Object.freeze(this); }
  assert(view) { for (const admission of this.admissions) admission.assert(view); }
  find(AdmissionClass) {
    for (const admission of this.admissions) {
      if (admission instanceof AdmissionClass) return admission;
      if (admission instanceof CombinedAdmission) {
        const found = admission.find(AdmissionClass);
        if (found !== null) return found;
      }
    }
    return null;
  }
}
