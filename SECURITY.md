<!-- Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT -->

# Local-use boundaries

ProjectDesk is an unauthenticated local application prototype. Its current backend CORS
configuration is permissive. Run it only on loopback in a trusted local environment; it is
not qualified for public or shared-network hosting. Browser-origin restrictions and access
control need further work before that deployment model is appropriate.

The SQLite database can contain private notes and tasks. Back up through workspace export;
keep databases and exports out of public bug reports. Import and sample-data operations can
replace the workspace. Use a disposable database for tests.

The dependency versions reflect the reviewed build, not a promise of current vulnerability
clearance. Review dependency advisories before deployment. Third-party packages retain
their own licenses.

Report security issues to Sandip Kumar at scorpiosk@gmail.com with a minimal synthetic
reproduction. Do not send private databases or credentials.
