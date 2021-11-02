import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";

// Create a VPC for our cluster.
const vpc = new awsx.ec2.Vpc("eks-vpc", {});

/**
 * Per NodeGroup IAM: each NodeGroup will bring its own, specific instance role and profile.
 */

const managedPolicyArns: string[] = [
  "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
  "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
  "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
];

// Creates a role and attaches the EKS worker node IAM managed policies. Used a few times below,
// to create multiple roles, so we use a function to avoid repeating ourselves.
export function createRole(name: string): aws.iam.Role {
  const role = new aws.iam.Role(name, {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: "ec2.amazonaws.com",
    }),
  });

  let counter = 0;
  for (const policy of managedPolicyArns) {
    // Create RolePolicyAttachment without returning it.
    const rpa = new aws.iam.RolePolicyAttachment(
      `${name}-policy-${counter++}`,
      { policyArn: policy, role: role }
    );
  }

  return role;
}

// Now create the roles and instance profiles for the two worker groups.
const role1 = createRole("my-worker-role1");
const role2 = createRole("my-worker-role2");
const instanceProfile1 = new aws.iam.InstanceProfile("my-instance-profile1", {
  role: role1,
});
const instanceProfile2 = new aws.iam.InstanceProfile("my-instance-profile2", {
  role: role2,
});

// Create an EKS cluster with many IAM roles to register with the cluster auth.
const cluster = new eks.Cluster("my-cluster", {
  skipDefaultNodeGroup: true,
  vpcId: vpc.id,
  publicSubnetIds: vpc.publicSubnetIds,
  privateSubnetIds: vpc.privateSubnetIds,
  instanceRoles: [role1, role2],
  nodeAssociatePublicIpAddress: false,
});

// Now create multiple node groups, each using a different instance profile for each role.

// First, create a node group for fixed compute.
const fixedNodeGroup = cluster.createNodeGroup("my-cluster-ng1", {
  instanceType: "t2.medium",
  desiredCapacity: 1,
  minSize: 1,
  maxSize: 3,
  labels: { ondemand: "true" },
  instanceProfile: instanceProfile1,
  nodeAssociatePublicIpAddress: false,
});

// Now create a preemptible node group, using spot pricing, for our variable, ephemeral workloads.
const spotNodeGroup = new eks.NodeGroup(
  "my-cluster-ng2",
  {
    cluster: cluster,
    instanceType: "t2.medium",
    desiredCapacity: 0,
    spotPrice: "1",
    minSize: 0,
    maxSize: 2,
    labels: { preemptible: "true" },
    taints: {
      special: {
        value: "true",
        effect: "NoSchedule",
      },
    },
    instanceProfile: instanceProfile2,
    nodeAssociatePublicIpAddress: false,
  },
  {
    providers: { kubernetes: cluster.provider },
  }
);

// Export the cluster's kubeconfig.
export const kubeconfig = cluster.kubeconfig;
