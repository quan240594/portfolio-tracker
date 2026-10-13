# Partial configuration — supply the rest at init time:
#   terraform init -backend-config=backend.hcl
# See backend.hcl.example and README.md ("Bootstrap remote state").
terraform {
  backend "s3" {}
}
