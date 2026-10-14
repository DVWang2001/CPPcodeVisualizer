// UML 物件圖教案 CC-2602B：分數向量的總和、乘積與平均（Frac 建構時自動約分）
// （改寫自 CF 題目 CC-2602B：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
#include<vector>
using namespace std;
int gcd(int a,int b){
   if(a<0)a=-a;
   if(b<0)b=-b;
   return b==0?a:gcd(b,a%b);
}
class Frac{public:
  long long m_n,m_d;
  Frac(int n=0,int d=1):m_n(n),m_d(d){
    long long g=gcd((int)m_n,(int)m_d);
    if(g!=0){ m_n/=g; m_d/=g; }
  }
  Frac add(const Frac& b)const{
    return Frac((int)(m_n*b.m_d+m_d*b.m_n),(int)(m_d*b.m_d));
  }
  Frac mul(const Frac& b)const{
    return Frac((int)(m_n*b.m_n),(int)(m_d*b.m_d));
  }
  Frac div(int b)const{
    return Frac((int)m_n,(int)(m_d*b));
  }
  void read(){
    int p,q;char c;
    cin>>p>>c>>q;
    m_n=p;m_d=q;
  }
  void print()const{cout<<m_n<<"/"<<m_d;}
};
class FVec{public:
  vector<Frac> m_vs;
  Frac sum()const{
    Frac s=m_vs[0];
    for(int i=1;i<m_vs.size();i++) s=s.add(m_vs[i]);
    return s;
  }
  Frac pro()const{
    Frac p=m_vs[0];
    for(int i=1;i<m_vs.size();i++) p=p.mul(m_vs[i]);
    return p;
  }
  Frac avg()const{
    return sum().div((int)m_vs.size());
  }
  void read(){
    int n;cin>>n;
    for(int i=0;i<n;i++){Frac f;f.read();m_vs.push_back(f);}
  }
};
int main(){
  FVec a;a.read();
  a.sum().print();cout<<endl;a.pro().print();cout<<endl;a.avg().print();cout<<endl;  //@ @guide uml:a
  return 0;
}
