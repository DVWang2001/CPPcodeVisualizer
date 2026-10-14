// UML 物件圖教案 CC-2608B：分數向量（long long 分子分母，約分後輸出）
// （改寫自 CF 題目 CC-2608B：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
#include<vector>
using namespace std;
typedef long long LL;
LL gcdLL(LL a,LL b){
   if(a<0)a=-a;
   if(b<0)b=-b;
   return b==0?a:gcdLL(b,a%b);
}
class Frac{public:
  LL m_n,m_d;
  Frac(LL n=0,LL d=1):m_n(n),m_d(d){}
  void addTo(Frac b){m_n=m_n*b.m_d+m_d*b.m_n;m_d*=b.m_d;}
  void mulBy(Frac b){m_n=m_n*b.m_n;m_d*=b.m_d;}
  Frac div(int b){return  Frac(m_n,m_d*b);}
  void read(){
    char c;
    cin>>m_n>>c>>m_d;
  }
  void print(){cout<<m_n<<"/"<<m_d;}
};
class FVec{public:
  vector<Frac> m_vs;
  Frac reduce(Frac f){
    LL g=gcdLL(f.m_n,f.m_d);
    if(g!=0){ f.m_n/=g; f.m_d/=g; }
    return f;
  }
  Frac sum(){
    Frac s;
    for(int i=0;i<m_vs.size();i++) s.addTo(m_vs[i]);
    return reduce(s);
  }
  Frac pro(){
    Frac p(1,1);
    for(int i=0;i<m_vs.size();i++) p.mulBy(m_vs[i]);
    return reduce(p);
  }
  Frac avg(){
    return reduce(sum().div((int)m_vs.size()));
  }
  void read(){
    int n;cin>>n;Frac v;
    while(n--){v.read();m_vs.push_back(v);}
  }
};
int main(){
  FVec a;a.read();
  a.sum().print();cout<<endl;a.pro().print();cout<<endl;a.avg().print();cout<<endl;  //@ @guide uml:a
  return 0;
}
