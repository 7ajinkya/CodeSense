import heapq
n,m=map(int,input().split())
graph=[[]for _ in range(n+1)]
in_degree=[0]*(n+1)
for _ in range(m):
    u,v=map(int,input().split())
    graph[u].append(v)
    in_degree[v]+=1
pq=[]
for i in range(1,n+1):
    if in_degree[i]==0:
        heapq.heappush(pq,i)
ans=[]
while pq:
    curr=heapq.heappop(pq)
    ans+=[curr]
    for neighbor in graph[curr]:
        in_degree[neighbor]-=1
        if in_degree[neighbor]==0:
            heapq.heappush(pq,neighbor)
if len(ans)==n:print(*(ans))
else:print(-1)